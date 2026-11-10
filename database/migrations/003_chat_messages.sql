CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  visitor_digest TEXT NOT NULL CHECK (length(visitor_digest) = 64),
  nickname TEXT NOT NULL CHECK (length(nickname) BETWEEN 1 AND 24 AND length(CAST(nickname AS BLOB)) <= 48),
  body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) BETWEEN 1 AND 360)
) STRICT;

CREATE INDEX chat_messages_visitor_body_time ON chat_messages(visitor_digest, body, created_at DESC);
CREATE INDEX chat_messages_created_id ON chat_messages(created_at DESC, id DESC);

CREATE TABLE chat_idempotency (
  visitor_digest TEXT NOT NULL CHECK (length(visitor_digest) = 64),
  request_id TEXT NOT NULL CHECK (length(request_id) = 36),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  message_id INTEGER NOT NULL CHECK (message_id > 0),
  PRIMARY KEY (visitor_digest, request_id)
) STRICT;

CREATE INDEX chat_idempotency_created ON chat_idempotency(created_at, visitor_digest, request_id);
CREATE INDEX chat_idempotency_visitor_created ON chat_idempotency(visitor_digest, created_at DESC);

CREATE TABLE chat_message_removals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL CHECK (message_id > 0),
  removed_at INTEGER NOT NULL CHECK (removed_at >= 0)
) STRICT;

CREATE INDEX chat_message_removals_time ON chat_message_removals(removed_at, id);
