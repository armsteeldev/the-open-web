import type { DatabaseSync } from 'node:sqlite';
import { payloadHash } from '../plain-text.js';
import type { StorySubmission } from './validation.js';

export const STORY_CONTRIBUTIONS_PER_CHAPTER = 40;
export const STORY_CHAPTER_CAP = 100;
export const STORY_CONTRIBUTION_CAP = STORY_CONTRIBUTIONS_PER_CHAPTER * STORY_CHAPTER_CAP;
export const STORY_COOLDOWN_MS = 10_000;
export const STORY_IDEMPOTENCY_MS = 24 * 60 * 60 * 1000;
export const STORY_IDEMPOTENCY_CAP = 10_000;
export const STORY_VISITOR_CAP = 50_000;

export interface StoryContribution {
  readonly id: number;
  readonly ordinal: number;
  readonly createdAt: number;
  readonly passage: string;
  readonly removed: boolean;
}

export interface StoryChapter {
  readonly number: number;
  readonly status: 'current' | 'archived';
  readonly openedAt: number;
  readonly closedAt: number | null;
  readonly revision: number;
  readonly contributions: readonly StoryContribution[];
}

export interface StoryState {
  readonly chapter: StoryChapter | null;
  readonly currentChapterNo: number | null;
  readonly currentRevision: number;
  readonly chapterCount: number;
  readonly full: boolean;
}

interface ChapterRow {
  id: number;
  chapter_no: number;
  status: 'current' | 'archived';
  opened_at: number;
  closed_at: number | null;
  revision: number;
}

interface ContributionRow {
  id: number;
  ordinal: number;
  created_at: number;
  body: string | null;
  removed_at: number | null;
}

function immediate<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* the transaction may already have rolled back */ }
    throw error;
  }
}

function deferred<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* the transaction may already have rolled back */ }
    throw error;
  }
}

function mapChapter(db: DatabaseSync, row: ChapterRow): StoryChapter {
  const contributions = db.prepare(`SELECT id, ordinal, created_at, body, removed_at
  FROM story_contributions WHERE chapter_id=? ORDER BY ordinal`).all(row.id) as unknown as ContributionRow[];
  return {
    number: row.chapter_no,
    status: row.status,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    revision: row.revision,
    contributions: contributions.map(item => ({
      id: item.id,
      ordinal: item.ordinal,
      createdAt: item.created_at,
      passage: item.body ?? 'A passage was removed.',
      removed: item.body === null,
    })),
  };
}

function currentChapter(db: DatabaseSync): ChapterRow | undefined {
  return db.prepare(`SELECT id, chapter_no, status, opened_at, closed_at, revision
    FROM story_chapters WHERE status='current'`).get() as ChapterRow | undefined;
}

function stateWithinTransaction(db: DatabaseSync, requestedChapterNo?: number): StoryState {
  const chapterCount = Number((db.prepare('SELECT COUNT(*) AS count FROM story_chapters').get() as { count: number }).count);
  const current = currentChapter(db);
  let selected: ChapterRow | undefined;
  if (requestedChapterNo !== undefined) {
    selected = db.prepare(`SELECT id, chapter_no, status, opened_at, closed_at, revision
      FROM story_chapters WHERE chapter_no=?`).get(requestedChapterNo) as ChapterRow | undefined;
  } else {
    selected = current ?? db.prepare(`SELECT id, chapter_no, status, opened_at, closed_at, revision
      FROM story_chapters ORDER BY chapter_no DESC LIMIT 1`).get() as ChapterRow | undefined;
  }
  return {
    chapter: selected ? mapChapter(db, selected) : null,
    currentChapterNo: current?.chapter_no ?? null,
    currentRevision: current?.revision ?? 0,
    chapterCount,
    full: !current && chapterCount >= STORY_CHAPTER_CAP,
  };
}

export function readStoryState(db: DatabaseSync, requestedChapterNo?: number): StoryState {
  return deferred(db, () => stateWithinTransaction(db, requestedChapterNo));
}

function cleanup(db: DatabaseSync, now: number): void {
  db.prepare('DELETE FROM story_idempotency WHERE created_at < ?').run(now - STORY_IDEMPOTENCY_MS);
  db.prepare('DELETE FROM story_visitor_cooldowns WHERE submitted_at <= ?').run(now - STORY_COOLDOWN_MS);
}

export type AppendStoryResult =
  | { readonly ok: true; readonly duplicate: boolean; readonly contribution: StoryContribution; readonly state: StoryState }
  | { readonly ok: false; readonly reason: 'stale' | 'cooldown' | 'full' | 'capacity' | 'idempotency-conflict'; readonly retryAfterMs?: number; readonly state?: StoryState };

export function appendStoryContribution(
  db: DatabaseSync,
  visitorDigest: string,
  submission: StorySubmission,
  now = Date.now(),
): AppendStoryResult {
  const hash = payloadHash([submission.chapterNo, submission.revision, submission.passage]);
  return immediate(db, () => {
    cleanup(db, now);
    const previous = db.prepare(`SELECT i.payload_hash, c.id, c.ordinal, c.created_at, c.body, c.removed_at
      FROM story_idempotency i JOIN story_contributions c ON c.id=i.contribution_id
      WHERE i.visitor_digest=? AND i.request_id=?`).get(visitorDigest, submission.requestId) as
      ({ payload_hash: string } & ContributionRow) | undefined;
    if (previous) {
      if (previous.payload_hash !== hash) return { ok: false, reason: 'idempotency-conflict' } as const;
      const chapter = db.prepare(`SELECT id, chapter_no, status, opened_at, closed_at, revision
      FROM story_chapters WHERE id=(SELECT chapter_id FROM story_contributions WHERE id=?)`).get(previous.id) as unknown as ChapterRow;
      return {
        ok: true,
        duplicate: true,
        contribution: {
          id: previous.id,
          ordinal: previous.ordinal,
          createdAt: previous.created_at,
          passage: previous.body ?? 'A passage was removed.',
          removed: previous.body === null,
        },
        state: stateWithinTransaction(db, currentChapter(db)?.chapter_no ?? chapter.chapter_no),
      } as const;
    }

    let current = currentChapter(db);
    const totalContributions = Number((db.prepare('SELECT COUNT(*) AS count FROM story_contributions').get() as { count: number }).count);
    const chapterCount = Number((db.prepare('SELECT COUNT(*) AS count FROM story_chapters').get() as { count: number }).count);
    if (!current && chapterCount >= STORY_CHAPTER_CAP) return { ok: false, reason: 'full' } as const;
    if (current) {
      if (submission.chapterNo !== current.chapter_no || submission.revision !== current.revision) {
        return { ok: false, reason: 'stale', state: stateWithinTransaction(db, current.chapter_no) } as const;
      }
    } else if (chapterCount > 0 || submission.chapterNo !== null || submission.revision !== 0) {
      return { ok: false, reason: 'stale', state: stateWithinTransaction(db) } as const;
    }
    if (totalContributions >= STORY_CONTRIBUTION_CAP) return { ok: false, reason: 'full' } as const;

    const cooldown = db.prepare('SELECT submitted_at FROM story_visitor_cooldowns WHERE visitor_digest=?')
      .get(visitorDigest) as { submitted_at: number } | undefined;
    if (cooldown && cooldown.submitted_at + STORY_COOLDOWN_MS > now) {
      return { ok: false, reason: 'cooldown', retryAfterMs: cooldown.submitted_at + STORY_COOLDOWN_MS - now } as const;
    }
    const idempotencyCount = Number((db.prepare('SELECT COUNT(*) AS count FROM story_idempotency').get() as { count: number }).count);
    const cooldownCount = Number((db.prepare('SELECT COUNT(*) AS count FROM story_visitor_cooldowns').get() as { count: number }).count);
    if (idempotencyCount >= STORY_IDEMPOTENCY_CAP || cooldownCount >= STORY_VISITOR_CAP) {
      return { ok: false, reason: 'capacity' } as const;
    }

    if (!current) {
      db.prepare(`INSERT INTO story_chapters(chapter_no, status, opened_at, revision) VALUES (1, 'current', ?, 0)`).run(now);
      current = currentChapter(db)!;
    }
    const count = Number((db.prepare('SELECT COUNT(*) AS count FROM story_contributions WHERE chapter_id=?').get(current.id) as { count: number }).count);
    const ordinal = count + 1;
    const contributionId = Number(db.prepare(`INSERT INTO story_contributions(chapter_id, ordinal, created_at, body)
      VALUES (?, ?, ?, ?) RETURNING id`).get(current.id, ordinal, now, submission.passage)!.id);
    db.prepare('UPDATE story_chapters SET revision=revision+1 WHERE id=?').run(current.id);
    db.prepare('INSERT INTO story_visitor_cooldowns(visitor_digest, submitted_at) VALUES (?, ?)').run(visitorDigest, now);
    db.prepare(`INSERT INTO story_idempotency(visitor_digest, request_id, payload_hash, created_at, contribution_id)
      VALUES (?, ?, ?, ?, ?)`).run(visitorDigest, submission.requestId, hash, now, contributionId);

    if (ordinal === STORY_CONTRIBUTIONS_PER_CHAPTER) {
      db.prepare(`UPDATE story_chapters SET status='archived', closed_at=? WHERE id=?`).run(now, current.id);
      if (current.chapter_no < STORY_CHAPTER_CAP) {
        db.prepare(`INSERT INTO story_chapters(chapter_no, status, opened_at, revision) VALUES (?, 'current', ?, 0)`)
          .run(current.chapter_no + 1, now);
      }
    }
    const contribution: StoryContribution = {
      id: contributionId,
      ordinal,
      createdAt: now,
      passage: submission.passage,
      removed: false,
    };
    return {
      ok: true,
      duplicate: false,
      contribution,
      state: stateWithinTransaction(db, currentChapter(db)?.chapter_no ?? current.chapter_no),
    } as const;
  });
}

export function cleanupStoryState(db: DatabaseSync, now = Date.now()): void {
  immediate(db, () => cleanup(db, now));
}

export function removeStoryContribution(db: DatabaseSync, id: number, now = Date.now()): boolean {
  return immediate(db, () => {
    const row = db.prepare('SELECT chapter_id, body FROM story_contributions WHERE id=?').get(id) as
      { chapter_id: number; body: string | null } | undefined;
    if (!row || row.body === null) return false;
    db.prepare('UPDATE story_contributions SET body=NULL, removed_at=? WHERE id=?').run(now, id);
    db.prepare('UPDATE story_chapters SET revision=revision+1 WHERE id=? AND status=\'current\'').run(row.chapter_id);
    return true;
  });
}
