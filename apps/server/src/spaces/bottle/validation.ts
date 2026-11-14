export const BOTTLE_MAX_MESSAGE_BYTES = 500;
export const BOTTLE_MAX_SIGNATURE_BYTES = 48;
export const BOTTLE_MAX_SIGNATURE_CODEPOINTS = 24;
export const BOTTLE_MAX_SEEN_IDS = 20;

export interface ValidatedBottleSubmission {
  readonly requestId: string;
  readonly message: string;
  readonly signature: string | null;
}

export type BottleValidationError = 'invalid input' | 'empty message' | 'message too long' | 'signature too long';
export type BottleValidationResult =
  | { readonly ok: true; readonly value: ValidatedBottleSubmission }
  | { readonly ok: false; readonly error: BottleValidationError };

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bidiControls = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;
const forbiddenControls = /[\p{Cc}]/u;

function hasUnpairedSurrogate(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) return true;
  }
  return false;
}

function invalidText(value: string): boolean {
  return hasUnpairedSurrogate(value) || bidiControls.test(value) || forbiddenControls.test(value.replace(/[\t\r\n]/gu, ''));
}

function normalizeMessage(value: string): string {
  return value.normalize('NFC').replace(/\r\n?/gu, '\n').replace(/\t/gu, ' ').trim();
}

function normalizeSignature(value: unknown): { readonly ok: true; readonly value: string | null } | { readonly ok: false; readonly error: 'invalid input' | 'signature too long' } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string' || invalidText(value)) return { ok: false, error: 'invalid input' };
  const normalized = value.normalize('NFC').replace(/[\t\r\n\p{White_Space}]+/gu, ' ').trim();
  if (!normalized) return { ok: true, value: null };
  if (Array.from(normalized).length > BOTTLE_MAX_SIGNATURE_CODEPOINTS) return { ok: false, error: 'signature too long' };
  if (Buffer.byteLength(normalized, 'utf8') > BOTTLE_MAX_SIGNATURE_BYTES) return { ok: false, error: 'signature too long' };
  return { ok: true, value: normalized };
}

export function validateBottleSubmission(input: unknown): BottleValidationResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'invalid input' };
  const record = input as Record<string, unknown>;
  if (typeof record.requestId !== 'string' || !uuidV4.test(record.requestId) || typeof record.message !== 'string') {
    return { ok: false, error: 'invalid input' };
  }

  const signature = normalizeSignature(record.signature);
  if (!signature.ok) return { ok: false, error: signature.error };
  if (invalidText(record.message)) return { ok: false, error: 'invalid input' };
  const message = normalizeMessage(record.message);
  if (!message) return { ok: false, error: 'empty message' };
  if (Buffer.byteLength(message, 'utf8') > BOTTLE_MAX_MESSAGE_BYTES) return { ok: false, error: 'message too long' };

  return { ok: true, value: { requestId: record.requestId, message, signature: signature.value } };
}

export function validateBottleExclusions(value: unknown): { readonly ok: true; readonly ids: string[] } | { readonly ok: false } {
  if (value === undefined || value === '') return { ok: true, ids: [] };
  if (typeof value !== 'string') return { ok: false };
  const ids = value.split(',');
  if (ids.length > BOTTLE_MAX_SEEN_IDS || ids.some(id => !uuidV4.test(id))) return { ok: false };
  return { ok: true, ids: [...new Set(ids.map(id => id.toLowerCase()))] };
}
