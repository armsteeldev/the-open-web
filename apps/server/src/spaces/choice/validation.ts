import { fitsText, hasOnlyKeys, isRecord, isUuidV4, normalizePlainText } from '../plain-text.js';

export const CHOICE_QUESTION_MAX_CHARS = 120;
export const CHOICE_QUESTION_MAX_BYTES = 320;
export const CHOICE_OPTION_MAX_CHARS = 50;
export const CHOICE_OPTION_MAX_BYTES = 140;

export interface ChoiceProposal {
  readonly requestId: string;
  readonly question: string;
  readonly optionA: string;
  readonly optionB: string;
}

export type ChoiceValidation =
  | { readonly ok: true; readonly value: ChoiceProposal }
  | { readonly ok: false; readonly error: 'invalid input' | 'empty text' | 'text too long' | 'identical choices' };

export function validateChoiceProposal(input: unknown): ChoiceValidation {
  if (!isRecord(input) || !hasOnlyKeys(input, ['requestId', 'question', 'optionA', 'optionB']) || !isUuidV4(input.requestId)) {
    return { ok: false, error: 'invalid input' };
  }
  const question = normalizePlainText(input.question, false);
  const optionA = normalizePlainText(input.optionA, false);
  const optionB = normalizePlainText(input.optionB, false);
  if (question === null || optionA === null || optionB === null) return { ok: false, error: 'invalid input' };
  if (!question || !optionA || !optionB) return { ok: false, error: 'empty text' };
  if (!fitsText(question, CHOICE_QUESTION_MAX_CHARS, CHOICE_QUESTION_MAX_BYTES) ||
      !fitsText(optionA, CHOICE_OPTION_MAX_CHARS, CHOICE_OPTION_MAX_BYTES) ||
      !fitsText(optionB, CHOICE_OPTION_MAX_CHARS, CHOICE_OPTION_MAX_BYTES)) {
    return { ok: false, error: 'text too long' };
  }
  if (optionA.toLocaleLowerCase('en-US') === optionB.toLocaleLowerCase('en-US')) {
    return { ok: false, error: 'identical choices' };
  }
  return { ok: true, value: { requestId: input.requestId, question, optionA, optionB } };
}

export function validateChoiceVote(input: unknown): { readonly ok: true; readonly requestId: string; readonly choice: 'a' | 'b' } | { readonly ok: false } {
  if (!isRecord(input) || !hasOnlyKeys(input, ['requestId', 'choice']) || !isUuidV4(input.requestId) ||
      (input.choice !== 'a' && input.choice !== 'b')) return { ok: false };
  return { ok: true, requestId: input.requestId, choice: input.choice };
}

export function validateDecisionId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

export function validateDecisionCursor(value: unknown): number | null | false {
  if (value === undefined) return null;
  const id = validateDecisionId(value);
  return id ?? false;
}
