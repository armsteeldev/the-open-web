CREATE TABLE guestbook_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  display_name TEXT CHECK (display_name IS NULL OR (length(display_name) <= 24 AND length(CAST(display_name AS BLOB)) <= 48)),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 220 AND length(CAST(body AS BLOB)) BETWEEN 1 AND 500)
) STRICT;

CREATE INDEX guestbook_entries_created_id ON guestbook_entries(created_at DESC, id DESC);

CREATE TABLE guestbook_visitor_cooldowns (
  visitor_digest TEXT PRIMARY KEY CHECK (length(visitor_digest) = 64),
  submitted_at INTEGER NOT NULL CHECK (submitted_at >= 0)
) STRICT;

CREATE INDEX guestbook_visitor_cooldowns_time ON guestbook_visitor_cooldowns(submitted_at);

CREATE TABLE guestbook_idempotency (
  visitor_digest TEXT NOT NULL CHECK (length(visitor_digest) = 64),
  request_id TEXT NOT NULL CHECK (length(request_id) = 36),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  entry_id INTEGER NOT NULL REFERENCES guestbook_entries(id) ON DELETE CASCADE,
  PRIMARY KEY (visitor_digest, request_id)
) STRICT;

CREATE INDEX guestbook_idempotency_created ON guestbook_idempotency(created_at);

CREATE TABLE story_chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_no INTEGER NOT NULL UNIQUE CHECK (chapter_no BETWEEN 1 AND 100),
  status TEXT NOT NULL CHECK (status IN ('current', 'archived')),
  opened_at INTEGER NOT NULL CHECK (opened_at >= 0),
  closed_at INTEGER CHECK (closed_at IS NULL OR closed_at >= opened_at),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  CHECK ((status = 'current' AND closed_at IS NULL) OR (status = 'archived' AND closed_at IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX story_one_current_chapter ON story_chapters(status) WHERE status = 'current';

CREATE TABLE story_contributions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id INTEGER NOT NULL REFERENCES story_chapters(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 40),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  body TEXT CHECK (body IS NULL OR (length(body) BETWEEN 1 AND 220 AND length(CAST(body AS BLOB)) BETWEEN 1 AND 500)),
  removed_at INTEGER CHECK (removed_at IS NULL OR removed_at >= created_at),
  UNIQUE (chapter_id, ordinal),
  CHECK ((body IS NOT NULL AND removed_at IS NULL) OR (body IS NULL AND removed_at IS NOT NULL))
) STRICT;

CREATE INDEX story_contributions_chapter_ordinal ON story_contributions(chapter_id, ordinal);

CREATE TABLE story_visitor_cooldowns (
  visitor_digest TEXT PRIMARY KEY CHECK (length(visitor_digest) = 64),
  submitted_at INTEGER NOT NULL CHECK (submitted_at >= 0)
) STRICT;

CREATE INDEX story_visitor_cooldowns_time ON story_visitor_cooldowns(submitted_at);

CREATE TABLE story_idempotency (
  visitor_digest TEXT NOT NULL CHECK (length(visitor_digest) = 64),
  request_id TEXT NOT NULL CHECK (length(request_id) = 36),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  contribution_id INTEGER NOT NULL REFERENCES story_contributions(id) ON DELETE CASCADE,
  PRIMARY KEY (visitor_digest, request_id)
) STRICT;

CREATE INDEX story_idempotency_created ON story_idempotency(created_at);

CREATE TABLE questions_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 180 AND length(CAST(body AS BLOB)) BETWEEN 1 AND 420)
) STRICT;

CREATE INDEX questions_items_created_id ON questions_items(created_at DESC, id DESC);

CREATE TABLE questions_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions_items(id) ON DELETE CASCADE,
  visitor_digest TEXT NOT NULL CHECK (length(visitor_digest) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 300 AND length(CAST(body AS BLOB)) BETWEEN 1 AND 500),
  UNIQUE (question_id, visitor_digest)
) STRICT;

CREATE INDEX questions_answers_question_order ON questions_answers(question_id, created_at, id);
CREATE INDEX questions_answers_created_id ON questions_answers(created_at, id);

CREATE TABLE questions_item_idempotency (
  visitor_digest TEXT NOT NULL CHECK (length(visitor_digest) = 64),
  request_id TEXT NOT NULL CHECK (length(request_id) = 36),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  question_id INTEGER NOT NULL REFERENCES questions_items(id) ON DELETE CASCADE,
  PRIMARY KEY (visitor_digest, request_id)
) STRICT;

CREATE INDEX questions_item_idempotency_created ON questions_item_idempotency(created_at);

CREATE TABLE questions_answer_idempotency (
  visitor_digest TEXT NOT NULL CHECK (length(visitor_digest) = 64),
  request_id TEXT NOT NULL CHECK (length(request_id) = 36),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  answer_id INTEGER NOT NULL REFERENCES questions_answers(id) ON DELETE CASCADE,
  PRIMARY KEY (visitor_digest, request_id)
) STRICT;

CREATE INDEX questions_answer_idempotency_created ON questions_answer_idempotency(created_at);

CREATE TABLE questions_visitor_cooldowns (
  visitor_digest TEXT NOT NULL CHECK (length(visitor_digest) = 64),
  action TEXT NOT NULL CHECK (action IN ('question', 'answer')),
  acted_at INTEGER NOT NULL CHECK (acted_at >= 0),
  PRIMARY KEY (visitor_digest, action)
) STRICT;

CREATE INDEX questions_visitor_cooldowns_time ON questions_visitor_cooldowns(acted_at);

CREATE TABLE choice_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  question TEXT NOT NULL CHECK (length(question) BETWEEN 1 AND 120 AND length(CAST(question AS BLOB)) BETWEEN 1 AND 320),
  option_a TEXT NOT NULL CHECK (length(option_a) BETWEEN 1 AND 50 AND length(CAST(option_a AS BLOB)) BETWEEN 1 AND 140),
  option_b TEXT NOT NULL CHECK (length(option_b) BETWEEN 1 AND 50 AND length(CAST(option_b AS BLOB)) BETWEEN 1 AND 140),
  status TEXT NOT NULL CHECK (status IN ('queued', 'active', 'closed')),
  opened_at INTEGER CHECK (opened_at IS NULL OR opened_at >= created_at),
  closes_at INTEGER CHECK (closes_at IS NULL OR closes_at > opened_at),
  closed_at INTEGER CHECK (closed_at IS NULL OR closed_at >= closes_at),
  result_a INTEGER CHECK (result_a IS NULL OR result_a >= 0),
  result_b INTEGER CHECK (result_b IS NULL OR result_b >= 0),
  CHECK (lower(option_a) <> lower(option_b)),
  CHECK ((status = 'queued' AND opened_at IS NULL AND closes_at IS NULL AND closed_at IS NULL AND result_a IS NULL AND result_b IS NULL)
      OR (status = 'active' AND opened_at IS NOT NULL AND closes_at IS NOT NULL AND closed_at IS NULL AND result_a IS NULL AND result_b IS NULL)
      OR (status = 'closed' AND opened_at IS NOT NULL AND closes_at IS NOT NULL AND closed_at IS NOT NULL AND result_a IS NOT NULL AND result_b IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX choice_one_active_decision ON choice_decisions(status) WHERE status = 'active';
CREATE INDEX choice_decisions_queue ON choice_decisions(status, id);
CREATE INDEX choice_decisions_archive ON choice_decisions(status, closed_at DESC, id DESC);

CREATE TABLE choice_votes (
  decision_id INTEGER NOT NULL REFERENCES choice_decisions(id) ON DELETE CASCADE,
  visitor_digest TEXT NOT NULL CHECK (length(visitor_digest) = 64),
  choice TEXT NOT NULL CHECK (choice IN ('a', 'b')),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (decision_id, visitor_digest)
) STRICT;

CREATE TABLE choice_proposal_cooldowns (
  visitor_digest TEXT PRIMARY KEY CHECK (length(visitor_digest) = 64),
  proposed_at INTEGER NOT NULL CHECK (proposed_at >= 0)
) STRICT;

CREATE INDEX choice_proposal_cooldowns_time ON choice_proposal_cooldowns(proposed_at);

CREATE TABLE choice_proposal_idempotency (
  visitor_digest TEXT NOT NULL CHECK (length(visitor_digest) = 64),
  request_id TEXT NOT NULL CHECK (length(request_id) = 36),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  decision_id INTEGER NOT NULL REFERENCES choice_decisions(id) ON DELETE CASCADE,
  PRIMARY KEY (visitor_digest, request_id)
) STRICT;

CREATE INDEX choice_proposal_idempotency_created ON choice_proposal_idempotency(created_at);

CREATE TABLE choice_vote_idempotency (
  visitor_digest TEXT NOT NULL CHECK (length(visitor_digest) = 64),
  request_id TEXT NOT NULL CHECK (length(request_id) = 36),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  decision_id INTEGER NOT NULL REFERENCES choice_decisions(id) ON DELETE CASCADE,
  PRIMARY KEY (visitor_digest, request_id)
) STRICT;

CREATE INDEX choice_vote_idempotency_created ON choice_vote_idempotency(created_at);
