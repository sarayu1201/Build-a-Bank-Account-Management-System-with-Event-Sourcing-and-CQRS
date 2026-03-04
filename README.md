# Build-a-Bank-Account-Management-System-with-Event-Sourcing-and-CQRS

## Overview

This project implements a Bank Account Management System using **Event Sourcing** and **CQRS (Command Query Responsibility Segregation)** patterns. It provides a robust, auditable, and scalable backend for financial applications.

## Architecture

### Event Sourcing
- All state changes are stored as immutable events
- Complete audit trail of all account operations
- Enables time-travel queries to reconstruct historical state
- Events: `AccountCreated`, `MoneyDeposited`, `MoneyWithdrawn`, `AccountClosed`

### CQRS
- **Command Side**: Handles state changes through event generation
- **Query Side**: Reads from optimized projection tables
- Separate read and write models for optimal performance

### Snapshotting
- Automatic snapshots created every 50 events per account
- Optimizes aggregate loading by reducing event replay

## Project Structure

```
.
├── src/
│   └── index.js          # Main application with all endpoints
├── seeds/
│   └── init.sql          # Database schema initialization
├── docker-compose.yml    # Docker orchestration
├── Dockerfile            # Application container
├── .env.example          # Environment variables template
├── package.json          # Node.js dependencies
└── submission.json       # Test account data
```

## Quick Start

### Prerequisites
- Docker and Docker Compose
- Node.js 18+

### Running the Application

1. Clone the repository
2. Copy `.env.example` to `.env`
3. Start all services:

```bash
docker-compose up --build
```

The application will be available at `http://localhost:8080`

## API Endpoints

### Command Endpoints (Write Model)

#### Create Account
```
POST /api/accounts
Content-Type: application/json

{
  "accountId": "acc-123",
  "ownerName": "John Doe",
  "initialBalance": 1000,
  "currency": "USD"
}
```

#### Deposit Money
```
POST /api/accounts/{accountId}/deposit
Content-Type: application/json

{
  "amount": 500,
  "description": "Salary deposit",
  "transactionId": "txn-001"
}
```

#### Withdraw Money
```
POST /api/accounts/{accountId}/withdraw
Content-Type: application/json

{
  "amount": 200,
  "description": "ATM withdrawal",
  "transactionId": "txn-002"
}
```

#### Close Account
```
POST /api/accounts/{accountId}/close
Content-Type: application/json

{
  "reason": "Customer request"
}
```

### Query Endpoints (Read Model)

#### Get Account
```
GET /api/accounts/{accountId}
```

#### Get Account Events
```
GET /api/accounts/{accountId}/events
```

#### Get Balance at Timestamp (Time Travel)
```
GET /api/accounts/{accountId}/balance-at/{timestamp}
```

#### Get Transactions (Paginated)
```
GET /api/accounts/{accountId}/transactions?page=1&pageSize=10
```

#### Get Projection Status
```
GET /api/projections/status
```

#### Rebuild Projections
```
POST /api/projections/rebuild
```

### Health Check
```
GET /health
```

## Database Schema

### Event Store
- `events`: Immutable event log with aggregate_id, event_type, event_data

### Snapshots
- `snapshots`: Periodic state snapshots for performance optimization

### Projections
- `account_summaries`: Current account state (balance, status)
- `transaction_history`: Denormalized transaction list

## Environment Variables

| Variable | Description | Example |
|----------|-------------|----------|
| API_PORT | Application port | 8080 |
| DATABASE_URL | PostgreSQL connection string | postgresql://user:pass@db:5432/bank_db |
| DB_USER | Database username | user |
| DB_PASSWORD | Database password | password |
| DB_NAME | Database name | bank_db |

## Testing

Run the test suite:
```bash
npm test
```

## License

ISC
