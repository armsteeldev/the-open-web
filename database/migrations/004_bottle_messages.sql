CREATE TABLE bottle_messages (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) BETWEEN 1 AND 500),
  signature TEXT CHECK (signature IS NULL OR length(CAST(signature AS BLOB)) BETWEEN 1 AND 48)
) STRICT;

CREATE INDEX bottle_messages_created ON bottle_messages(created_at ASC);

CREATE TABLE bottle_visitor_cooldowns (
  visitor_digest TEXT PRIMARY KEY NOT NULL CHECK (length(visitor_digest) = 64),
  released_at INTEGER NOT NULL CHECK (released_at >= 0)
) STRICT;

CREATE INDEX bottle_visitor_cooldowns_released ON bottle_visitor_cooldowns(released_at ASC);

CREATE TABLE bottle_idempotency (
  visitor_digest TEXT NOT NULL CHECK (length(visitor_digest) = 64),
  request_id TEXT NOT NULL CHECK (length(request_id) = 36),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  bottle_id TEXT NOT NULL CHECK (length(bottle_id) = 36),
  PRIMARY KEY (visitor_digest, request_id)
) STRICT;

CREATE INDEX bottle_idempotency_created ON bottle_idempotency(created_at ASC);
