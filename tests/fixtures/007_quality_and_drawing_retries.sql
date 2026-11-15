CREATE INDEX guestbook_idempotency_entry_id_idx ON guestbook_idempotency(entry_id);
CREATE INDEX story_idempotency_contribution_id_idx ON story_idempotency(contribution_id);
CREATE INDEX questions_item_idempotency_question_id_idx ON questions_item_idempotency(question_id);
CREATE INDEX questions_answer_idempotency_answer_id_idx ON questions_answer_idempotency(answer_id);
CREATE INDEX choice_proposal_idempotency_decision_id_idx ON choice_proposal_idempotency(decision_id);
CREATE INDEX choice_vote_idempotency_decision_id_idx ON choice_vote_idempotency(decision_id);

CREATE INDEX questions_answers_question_updated_id_idx ON questions_answers(question_id, updated_at DESC, id DESC);
CREATE INDEX questions_answers_updated_id_idx ON questions_answers(updated_at DESC, id DESC);

CREATE TABLE draw_submission_idempotency (
  request_id TEXT PRIMARY KEY CHECK (
    length(request_id) = 36
    AND request_id = lower(request_id)
    AND substr(request_id, 9, 1) = '-'
    AND substr(request_id, 14, 1) = '-'
    AND substr(request_id, 15, 1) = '4'
    AND substr(request_id, 19, 1) = '-'
    AND substr(request_id, 20, 1) IN ('8', '9', 'a', 'b')
    AND substr(request_id, 24, 1) = '-'
    AND request_id NOT GLOB '*[^0-9a-f-]*'
  ),
  payload_hash TEXT NOT NULL CHECK (
    length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'
  ),
  drawing_id INTEGER NOT NULL UNIQUE REFERENCES draw_drawings(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE INDEX draw_submission_idempotency_created ON draw_submission_idempotency(created_at);
