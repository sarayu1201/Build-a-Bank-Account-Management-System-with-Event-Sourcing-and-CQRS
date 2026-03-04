const express = require('express');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const API_PORT = process.env.API_PORT || 8080;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

// Event Store
const eventStore = {
  async appendEvents(events) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const event of events) {
        await client.query(
          'INSERT INTO events (event_id, aggregate_id, aggregate_type, event_type, event_data, event_number, timestamp, version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [event.eventId, event.aggregateId, event.aggregateType, event.eventType, JSON.stringify(event.data), event.eventNumber, event.timestamp, event.version]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
  async getEvents(aggregateId) {
    const result = await pool.query('SELECT * FROM events WHERE aggregate_id = $1 ORDER BY event_number', [aggregateId]);
    return result.rows.map(row => ({
      eventId: row.event_id, aggregateId: row.aggregate_id, aggregateType: row.aggregate_type,
      eventType: row.event_type, data: row.event_data, eventNumber: row.event_number,
      timestamp: row.timestamp, version: row.version
    }));
  },
  async getAllEvents() {
    const result = await pool.query('SELECT * FROM events ORDER BY event_number');
    return result.rows;
  }
};

// Snapshot Store
const snapshotStore = {
  async getSnapshot(aggregateId) {
    const result = await pool.query('SELECT * FROM snapshots WHERE aggregate_id = $1', [aggregateId]);
    return result.rows[0];
  },
  async saveSnapshot(aggregateId, snapshotData, lastEventNumber) {
    await pool.query(
      'INSERT INTO snapshots (snapshot_id, aggregate_id, snapshot_data, last_event_number) VALUES ($1, $2, $3, $4) ON CONFLICT (aggregate_id) DO UPDATE SET snapshot_data = $3, last_event_number = $4, created_at = NOW()',
      [uuidv4(), aggregateId, JSON.stringify(snapshotData), lastEventNumber]
    );
  }
};

// Projection Store
const projectionStore = {
  async updateAccountSummary(accountId, ownerName, balance, currency, status, version) {
    await pool.query(
      'INSERT INTO account_summaries (account_id, owner_name, balance, currency, status, version) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (account_id) DO UPDATE SET owner_name = $2, balance = $3, currency = $4, status = $5, version = $6',
      [accountId, ownerName, balance, currency, status, version]
    );
  },
  async addTransaction(transactionId, accountId, type, amount, description, timestamp) {
    await pool.query(
      'INSERT INTO transaction_history (transaction_id, account_id, type, amount, description, timestamp) VALUES ($1, $2, $3, $4, $5, $6)',
      [transactionId, accountId, type, amount, description, timestamp]
    );
  },
  async getAccountSummary(accountId) {
    const result = await pool.query('SELECT * FROM account_summaries WHERE account_id = $1', [accountId]);
    return result.rows[0];
  },
  async getTransactions(accountId, page = 1, pageSize = 10) {
    const offset = (page - 1) * pageSize;
    const result = await pool.query(
      'SELECT * FROM transaction_history WHERE account_id = $1 ORDER BY timestamp DESC LIMIT $2 OFFSET $3',
      [accountId, pageSize, offset]
    );
    const countResult = await pool.query('SELECT COUNT(*) FROM transaction_history WHERE account_id = $1', [accountId]);
    return {
      items: result.rows,
      totalCount: parseInt(countResult.rows[0].count),
      currentPage: page,
      pageSize: pageSize,
      totalPages: Math.ceil(countResult.rows[0].count / pageSize)
    };
  },
  async rebuildFromEvents(events) {
    await pool.query('DELETE FROM account_summaries');
    await pool.query('DELETE FROM transaction_history');
    for (const event of events) {
      await this.processEvent(event);
    }
  },
  async processEvent(event) {
    const data = typeof event.event_data === 'string' ? JSON.parse(event.event_data) : event.event_data;
    if (event.event_type === 'AccountCreated') {
      await this.updateAccountSummary(data.accountId, data.ownerName, data.initialBalance, data.currency, 'OPEN', event.event_number);
    } else if (event.event_type === 'MoneyDeposited') {
      const summary = await this.getAccountSummary(data.accountId);
      if (summary) {
        await this.updateAccountSummary(data.accountId, summary.owner_name, parseFloat(summary.balance) + data.amount, summary.currency, summary.status, event.event_number);
        await this.addTransaction(data.transactionId, data.accountId, 'DEPOSIT', data.amount, data.description, event.timestamp);
      }
    } else if (event.event_type === 'MoneyWithdrawn') {
      const summary = await this.getAccountSummary(data.accountId);
      if (summary) {
        await this.updateAccountSummary(data.accountId, summary.owner_name, parseFloat(summary.balance) - data.amount, summary.currency, summary.status, event.event_number);
        await this.addTransaction(data.transactionId, data.accountId, 'WITHDRAWAL', data.amount, data.description, event.timestamp);
      }
    } else if (event.event_type === 'AccountClosed') {
      const summary = await this.getAccountSummary(data.accountId);
      if (summary) {
        await this.updateAccountSummary(data.accountId, summary.owner_name, summary.balance, summary.currency, 'CLOSED', event.event_number);
      }
    }
  },
  async getProjectionStatus() {
    const totalEvents = await pool.query('SELECT COUNT(*) FROM events');
    const accountSummaries = await pool.query('SELECT MAX(version) as lastProcessed FROM account_summaries');
    const transactions = await pool.query('SELECT COUNT(*) FROM transaction_history');
    return {
      totalEventsInStore: parseInt(totalEvents.rows[0].count),
      projections: [
        { name: 'AccountSummaries', lastProcessedEventNumberGlobal: accountSummaries.rows[0].lastprocessed || 0, lag: 0 },
        { name: 'TransactionHistory', lastProcessedEventNumberGlobal: parseInt(transactions.rows[0].count), lag: 0 }
      ]
    };
  }
};

// Account Aggregate
const SNAPSHOT_THRESHOLD = 50;

class BankAccount {
  constructor(accountId) {
    this.accountId = accountId;
    this.ownerName = '';
    this.balance = 0;
    this.currency = 'USD';
    this.status = 'OPEN';
    this.events = [];
    this.version = 0;
  }

  static async load(accountId) {
    const account = new BankAccount(accountId);
    const snapshot = await snapshotStore.getSnapshot(accountId);
    let startEventNumber = 0;
    if (snapshot) {
      account.ownerName = snapshot.snapshot_data.ownerName;
      account.balance = parseFloat(snapshot.snapshot_data.balance);
      account.currency = snapshot.snapshot_data.currency;
      account.status = snapshot.snapshot_data.status;
      account.version = snapshot.snapshot_data.version;
      startEventNumber = snapshot.last_event_number;
    }
    const events = await eventStore.getEvents(accountId);
    const eventsToReplay = events.filter(e => e.eventNumber > startEventNumber);
    for (const event of eventsToReplay) {
      account.applyEvent(event);
    }
    return account;
  }

  applyEvent(event) {
    const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    if (event.eventType === 'AccountCreated') {
      this.ownerName = data.ownerName;
      this.balance = data.initialBalance;
      this.currency = data.currency;
      this.status = 'OPEN';
    } else if (event.eventType === 'MoneyDeposited') {
      this.balance += data.amount;
    } else if (event.eventType === 'MoneyWithdrawn') {
      this.balance -= data.amount;
    } else if (event.eventType === 'AccountClosed') {
      this.status = 'CLOSED';
    }
    this.version = event.eventNumber;
  }

  create(ownerName, initialBalance, currency) {
    if (this.version > 0) {
      throw new Error('Account already exists');
    }
    this.addEvent('AccountCreated', { accountId: this.accountId, ownerName, initialBalance, currency });
  }

  deposit(amount, description, transactionId) {
    if (this.status !== 'OPEN') throw new Error('Account is closed');
    if (amount <= 0) throw new Error('Amount must be positive');
    this.addEvent('MoneyDeposited', { accountId: this.accountId, amount, description, transactionId });
  }

  withdraw(amount, description, transactionId) {
    if (this.status !== 'OPEN') throw new Error('Account is closed');
    if (amount <= 0) throw new Error('Amount must be positive');
    if (this.balance < amount) throw new Error('Insufficient funds');
    this.addEvent('MoneyWithdrawn', { accountId: this.accountId, amount, description, transactionId });
  }

  close(reason) {
    if (this.balance !== 0) throw new Error('Cannot close account with non-zero balance');
    this.addEvent('AccountClosed', { accountId: this.accountId, reason });
  }

  addEvent(eventType, data) {
    this.events.push({
      eventId: uuidv4(),
      aggregateId: this.accountId,
      aggregateType: 'BankAccount',
      eventType,
      data,
      eventNumber: this.events.length + 1,
      timestamp: new Date().toISOString(),
      version: 1
    });
  }

  async persist() {
    if (this.events.length === 0) return;
    await eventStore.appendEvents(this.events);
    await projectionStore.rebuildFromEvents(this.events);
    if (this.events.length >= SNAPSHOT_THRESHOLD) {
      await snapshotStore.saveSnapshot(this.accountId, {
        ownerName: this.ownerName,
        balance: this.balance,
        currency: this.currency,
        status: this.status,
        version: this.version
      }, this.events[this.events.length - 1].eventNumber);
    }
    this.events = [];
  }
}

// Command Handlers (Write Model)
app.post('/api/accounts', async (req, res) => {
  try {
    const { accountId, ownerName, initialBalance = 0, currency = 'USD' } = req.body;
    const account = await BankAccount.load(accountId);
    account.create(ownerName, initialBalance, currency);
    await account.persist();
    res.status(202).json({ accountId, ownerName, balance: initialBalance, currency, status: 'OPEN' });
  } catch (error) {
    if (error.message === 'Account already exists') {
      res.status(409).json({ error: 'Account already exists' });
    } else {
      res.status(400).json({ error: error.message });
    }
  }
});

app.post('/api/accounts/:accountId/deposit', async (req, res) => {
  try {
    const { accountId } = req.params;
    const { amount, description, transactionId } = req.body;
    const account = await BankAccount.load(accountId);
    if (account.version === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }
    account.deposit(amount, description, transactionId);
    await account.persist();
    res.status(202).accept();
  } catch (error) {
    if (error.message === 'Account is closed') {
      res.status(409).json({ error: 'Account is closed' });
    } else if (error.message === 'Account not found') {
      res.status(404).json({ error: error.message });
    } else {
      res.status(400).json({ error: error.message });
    }
  }
});

app.post('/api/accounts/:accountId/withdraw', async (req, res) => {
  try {
    const { accountId } = req.params;
    const { amount, description, transactionId } = req.body;
    const account = await BankAccount.load(accountId);
    if (account.version === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }
    account.withdraw(amount, description, transactionId);
    await account.persist();
    res.status(202).accept();
  } catch (error) {
    if (error.message === 'Account is closed' || error.message === 'Insufficient funds') {
      res.status(409).json({ error: error.message });
    } else if (error.message === 'Account not found') {
      res.status(404).json({ error: error.message });
    } else {
      res.status(400).json({ error: error.message });
    }
  }
});

app.post('/api/accounts/:accountId/close', async (req, res) => {
  try {
    const { accountId } = req.params;
    const { reason } = req.body;
    const account = await BankAccount.load(accountId);
    if (account.version === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }
    account.close(reason);
    await account.persist();
    res.status(202).accept();
  } catch (error) {
    if (error.message === 'Cannot close account with non-zero balance') {
      res.status(409).json({ error: error.message });
    } else if (error.message === 'Account not found') {
      res.status(404).json({ error: error.message });
    } else {
      res.status(400).json({ error: error.message });
    }
  }
});

// Query Handlers (Read Model)
app.get('/api/accounts/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;
    const summary = await projectionStore.getAccountSummary(accountId);
    if (!summary) {
      return res.status(404).json({ error: 'Account not found' });
    }
    res.json({
      accountId: summary.account_id,
      ownerName: summary.owner_name,
      balance: parseFloat(summary.balance),
      currency: summary.currency,
      status: summary.status
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/accounts/:accountId/events', async (req, res) => {
  try {
    const { accountId } = req.params;
    const events = await eventStore.getEvents(accountId);
    res.json(events.map(e => ({
      eventId: e.eventId,
      eventType: e.eventType,
      eventNumber: e.eventNumber,
      data: typeof e.data === 'string' ? JSON.parse(e.data) : e.data,
      timestamp: e.timestamp
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/accounts/:accountId/balance-at/:timestamp', async (req, res) => {
  try {
    const { accountId, timestamp } = req.params;
    const events = await eventStore.getEvents(accountId);
    const targetTime = new Date(timestamp).getTime();
    let balance = 0;
    for (const event of events) {
      if (new Date(event.timestamp).getTime() <= targetTime) {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (event.eventType === 'AccountCreated') {
          balance = data.initialBalance;
        } else if (event.eventType === 'MoneyDeposited') {
          balance += data.amount;
        } else if (event.eventType === 'MoneyWithdrawn') {
          balance -= data.amount;
        }
      }
    }
    res.json({ accountId, balanceAt: balance, timestamp });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/accounts/:accountId/transactions', async (req, res) => {
  try {
    const { accountId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 10;
    const result = await projectionStore.getTransactions(accountId, page, pageSize);
    res.json({
      currentPage: result.currentPage,
      pageSize: result.pageSize,
      totalPages: result.totalPages,
      totalCount: result.totalCount,
      items: result.items.map(t => ({
        transactionId: t.transaction_id,
        type: t.type,
        amount: parseFloat(t.amount),
        description: t.description,
        timestamp: t.timestamp
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/projections/rebuild', async (req, res) => {
  try {
    const events = await eventStore.getAllEvents();
    await projectionStore.rebuildFromEvents(events);
    res.status(202).json({ message: 'Projection rebuild initiated.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/projections/status', async (req, res) => {
  try {
    const status = await projectionStore.getProjectionStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'healthy' });
  } catch (error) {
    res.status(503).json({ status: 'unhealthy', error: error.message });
  }
});

// Start server
app.listen(API_PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${API_PORT}`);
});
