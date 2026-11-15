import { fitsText, hasOnlyKeys, isRecord, isUuidV4, normalizePlainText } from '../plain-text.js';

export const GUESTBOOK_MESSAGE_MAX_CHARS = 220;
export const GUESTBOOK_MESSAGE_MAX_BYTES = 500;
export const GUESTBOOK_NAME_MAX_CHARS = 24;
export const GUESTBOOK_NAME_MAX_BYTES = 48;

export interface GuestbookSubmission {
  readonly requestId: string;
  readonly displayName: string | null;
  readonly message: string;
}

export type GuestbookValidation =
  | { readonly ok: true; readonly value: GuestbookSubmission }
  | { readonly ok: false; readonly error: 'invalid input' | 'empty message' | 'message too long' | 'name too long' };

export function validateGuestbookSubmission(input: unknown): GuestbookValidation {
  if (!isRecord(input) || !hasOnlyKeys(input, ['requestId', 'displayName', 'message']) || !isUuidV4(input.requestId)) {
    return { ok: false, error: 'invalid input' };
  }
  const message = normalizePlainText(input.message, true);
  if (message === null) return { ok: false, error: 'invalid input' };
  if (!message) return { ok: false, error: 'empty message' };
  if (!fitsText(message, GUESTBOOK_MESSAGE_MAX_CHARS, GUESTBOOK_MESSAGE_MAX_BYTES)) {
    return { ok: false, error: 'message too long' };
  }

  let displayName: string | null = null;
  if (input.displayName !== undefined && input.displayName !== null) {
    if (typeof input.displayName !== 'string') return { ok: false, error: 'invalid input' };
    const normalized = normalizePlainText(input.displayName, false);
    if (normalized === null) return { ok: false, error: 'invalid input' };
    if (!normalized) displayName = null;
    else if (!fitsText(normalized, GUESTBOOK_NAME_MAX_CHARS, GUESTBOOK_NAME_MAX_BYTES)) {
      return { ok: false, error: 'name too long' };
    } else displayName = normalized;
  }
  return { ok: true, value: { requestId: input.requestId, displayName, message } };
}

export function validateGuestbookCursor(value: unknown): number | null | false {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[1-9]\d{0,8}$/.test(value)) return false;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : false;
}
