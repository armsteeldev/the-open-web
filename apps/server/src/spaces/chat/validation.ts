export const CHAT_MAX_MESSAGE_BYTES = 360;
export const CHAT_MAX_NICKNAME_CODEPOINTS = 24;
export const CHAT_MAX_NICKNAME_BYTES = 48;

export type ValidatedChatSubmission = {
  readonly requestId: string;
  readonly nickname: string;
  readonly text: string;
};

export type ChatValidationError = 'invalid input' | 'empty message' | 'message too long' | 'invalid nickname';

export type ChatValidationResult =
  | { readonly ok: true; readonly value: ValidatedChatSubmission }
  | { readonly ok: false; readonly error: ChatValidationError };

const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const bidiControls = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;
const forbiddenControls = /[\p{Cc}]/u;

function hasUnpairedSurrogate(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) return true;
  }
  return false;
}

function normalizeNickname(value: unknown): string | null {
  if (value === undefined || value === null) return 'Anonymous';
  if (typeof value !== 'string' || hasUnpairedSurrogate(value) || bidiControls.test(value)) return null;
  if (forbiddenControls.test(value.replace(/[\t\r\n]/gu, ''))) return null;

  const normalized = value.normalize('NFC').replace(/[\t\r\n\p{White_Space}]+/gu, ' ').trim();
  if (!normalized) return 'Anonymous';
  if (/^anonymous\d+$/iu.test(normalized)) return null;
  if (Array.from(normalized).length > CHAT_MAX_NICKNAME_CODEPOINTS) return null;
  if (Buffer.byteLength(normalized, 'utf8') > CHAT_MAX_NICKNAME_BYTES) return null;
  return normalized;
}

export function validateChatSubmission(input: unknown): ChatValidationResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'invalid input' };
  const record = input as Record<string, unknown>;
  if (typeof record.text !== 'string' || typeof record.requestId !== 'string' || !requestIdPattern.test(record.requestId)) {
    return { ok: false, error: 'invalid input' };
  }

  const nickname = normalizeNickname(record.nickname);
  if (nickname === null) return { ok: false, error: 'invalid nickname' };

  const source = record.text;
  if (hasUnpairedSurrogate(source) || bidiControls.test(source)) return { ok: false, error: 'invalid input' };
  if (forbiddenControls.test(source.replace(/[\t\r\n]/gu, ''))) return { ok: false, error: 'invalid input' };
  const text = source.normalize('NFC').replace(/[\t\r\n\p{White_Space}]+/gu, ' ').trim();
  if (!text) return { ok: false, error: 'empty message' };
  if (Buffer.byteLength(text, 'utf8') > CHAT_MAX_MESSAGE_BYTES) return { ok: false, error: 'message too long' };

  return { ok: true, value: { requestId: record.requestId, nickname, text } };
}
