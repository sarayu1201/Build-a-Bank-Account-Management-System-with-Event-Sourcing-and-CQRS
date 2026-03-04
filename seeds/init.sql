-- Event Store Table
CREATE TABLE events (
  event_id UUID PRIMARY KEY NOT NULL,
  aggregate_id VARCHAR(255) NOT NULL,
  aggregate_type VARCHAR(255) NOT NULL,
  event_type VARCHAR(255) NOT NULL,
  event_data JSONB NOT NULL,
  event_number INTEGER NOT NULL,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (aggregate_id, event_number)
);

CREATE INDEX idx_events_aggregate_id ON events(aggregate_id);
CREATE INDEX idx_events_event_type ON events(event_type);
CREATE INDEX idx_events_timestamp ON events(timestamp);

-- Snapshots Table
CREATE TABLE snapshots (
  snapshot_id UUID PRIMARY KEY NOT NULL,
  aggregate_id VARCHAR(255) NOT NULL UNIQUE,
  snapshot_data JSONB NOT NULL,
  last_event_number INTEGER NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_snapshots_aggregate_id ON snapshots(aggregate_id);

-- Account Summaries Projection
CREATE TABLE account_summaries (
  account_id VARCHAR(255) PRIMARY KEY NOT NULL,
  owner_name VARCHAR(255) NOT NULL,
  balance DECIMAL(19, 4) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  status VARCHAR(50) NOT NULL,
  version BIGINT NOT NULL
);

CREATE INDEX idx_account_summaries_status ON account_summaries(status);

-- Transaction History Projection
CREATE TABLE transaction_history (
  transaction_id VARCHAR(255) PRIMARY KEY NOT NULL,
  account_id VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL,
  amount DECIMAL(19, 4) NOT NULL,
  description TEXT,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE INDEX idx_transaction_history_account_id ON transaction_history(account_id);
CREATE INDEX idx_transaction_history_timestamp ON transaction_history(timestamp);

-- Projection State Table (to track which events have been processed)
CREATE TABLE projection_state (
  projection_name VARCHAR(255) PRIMARY KEY NOT NULL,
  last_processed_event_number BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
