import { fitsText, hasOnlyKeys, isRecord, isUuidV4, normalizePlainText } from '../plain-text.js';

export const QUESTION_MAX_CHARS = 180;
export const QUESTION_MAX_BYTES = 420;
export const ANSWER_MAX_CHARS = 300;
export const ANSWER_MAX_BYTES = 500;

export interface QuestionSubmission {
  readonly requestId: string;
  readonly text: string;
}

export type QuestionsValidation =
  | { readonly ok: true; readonly value: QuestionSubmission }
  | { readonly ok: false; readonly error: 'invalid input' | 'empty text' | 'text too long' };

function validateTextSubmission(input: unknown, maxChars: number, maxBytes: number, multiline: boolean): QuestionsValidation {
  if (!isRecord(input) || !hasOnlyKeys(input, ['requestId', 'text']) || !isUuidV4(input.requestId)) {
    return { ok: false, error: 'invalid input' };
  }
  const text = normalizePlainText(input.text, multiline);
  if (text === null) return { ok: false, error: 'invalid input' };
  if (!text) return { ok: false, error: 'empty text' };
  if (!fitsText(text, maxChars, maxBytes)) return { ok: false, error: 'text too long' };
  return { ok: true, value: { requestId: input.requestId, text } };
}

export function validateQuestionSubmission(input: unknown): QuestionsValidation {
  return validateTextSubmission(input, QUESTION_MAX_CHARS, QUESTION_MAX_BYTES, false);
}

export function validateAnswerSubmission(input: unknown): QuestionsValidation {
  return validateTextSubmission(input, ANSWER_MAX_CHARS, ANSWER_MAX_BYTES, true);
}

export function validateQuestionId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

export function validateQuestionCursor(value: unknown): number | null | false {
  if (value === undefined) return null;
  const id = validateQuestionId(value);
  return id ?? false;
}
