import { fitsText, hasOnlyKeys, isRecord, isUuidV4, normalizePlainText } from '../plain-text.js';

export const STORY_PASSAGE_MAX_CHARS = 220;
export const STORY_PASSAGE_MAX_BYTES = 500;

export interface StorySubmission {
  readonly requestId: string;
  readonly chapterNo: number | null;
  readonly revision: number;
  readonly passage: string;
}

export type StoryValidation =
  | { readonly ok: true; readonly value: StorySubmission }
  | { readonly ok: false; readonly error: 'invalid input' | 'empty passage' | 'passage too long' };

export function validateStorySubmission(input: unknown): StoryValidation {
  if (!isRecord(input) || !hasOnlyKeys(input, ['requestId', 'chapterNo', 'revision', 'passage']) || !isUuidV4(input.requestId)) {
    return { ok: false, error: 'invalid input' };
  }
  const chapterNo = input.chapterNo;
  const revision = input.revision;
  if (chapterNo !== null && (!Number.isSafeInteger(chapterNo) || Number(chapterNo) < 1 || Number(chapterNo) > 100)) {
    return { ok: false, error: 'invalid input' };
  }
  if (!Number.isSafeInteger(revision) || Number(revision) < 0 || Number(revision) > 10_000) {
    return { ok: false, error: 'invalid input' };
  }
  const passage = normalizePlainText(input.passage, true);
  if (passage === null) return { ok: false, error: 'invalid input' };
  if (!passage) return { ok: false, error: 'empty passage' };
  if (!fitsText(passage, STORY_PASSAGE_MAX_CHARS, STORY_PASSAGE_MAX_BYTES)) {
    return { ok: false, error: 'passage too long' };
  }
  return { ok: true, value: { requestId: input.requestId, chapterNo: chapterNo as number | null, revision: revision as number, passage } };
}

export function validateChapterNumber(value: unknown): number | null | false {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[1-9]\d{0,2}$/.test(value)) return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= 100 ? number : false;
}
