import { createHash } from 'node:crypto';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

export function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Normalize public text while keeping markup inert and rejecting invisible direction tricks. */
export function normalizePlainText(value: unknown, multiline: boolean): string | null {
  if (typeof value !== 'string' || hasUnpairedSurrogate(value) || BIDI_CONTROLS.test(value)) return null;
  let normalized = value.normalize('NFC').replace(/\r\n?/gu, '\n').replace(/\t/gu, ' ');
  if (multiline) {
    if (/[\p{Cc}]/u.test(normalized.replace(/\n/gu, ''))) return null;
  } else {
    if (/[\p{Cc}]/u.test(normalized.replace(/[\n\p{White_Space}]/gu, ''))) return null;
    normalized = normalized.replace(/[\p{White_Space}]+/gu, ' ');
  }
  return normalized.trim();
}

export function fitsText(value: string, maxCodePoints: number, maxBytes: number): boolean {
  return Array.from(value).length <= maxCodePoints && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

export function payloadHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
