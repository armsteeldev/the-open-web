import type { DatabaseSync } from 'node:sqlite';
import type { ISO_3166_ALPHA2_CODES } from '../../../../../packages/shared/countries.js';

export const MAP_CONTRIBUTION_CAP = 100_000;
export type CountryCode = typeof ISO_3166_ALPHA2_CODES[number];
interface CountryRow { country_code: CountryCode; count: number }

export function readMapState(db: DatabaseSync, visitorDigest: string | null): {
  readonly countries: readonly { readonly code: CountryCode; readonly count: number }[];
  readonly total: number;
  readonly yourCountry: CountryCode | null;
} {
  const countries = db.prepare('SELECT country_code, COUNT(*) AS count FROM map_contributions GROUP BY country_code ORDER BY country_code').all() as unknown as CountryRow[];
  const total = countries.reduce((sum, country) => sum + Number(country.count), 0);
  const own = visitorDigest
    ? db.prepare('SELECT country_code FROM map_contributions WHERE visitor_digest=?').get(visitorDigest) as { country_code: CountryCode } | undefined
    : undefined;
  return {
    countries: countries.map(country => ({ code: country.country_code, count: Number(country.count) })),
    total,
    yourCountry: own?.country_code ?? null,
  };
}

export type MapContributionResult =
  | { readonly ok: true; readonly removed: boolean }
  | { readonly ok: false; readonly reason: 'full' | 'not-found' };

export function setMapContribution(
  db: DatabaseSync,
  visitorDigest: string,
  countryCode: CountryCode | null,
  now = Date.now(),
): MapContributionResult {
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare('SELECT 1 FROM map_contributions WHERE visitor_digest=?').get(visitorDigest);
    if (countryCode === null) {
      const removed = Number(db.prepare('DELETE FROM map_contributions WHERE visitor_digest=?').run(visitorDigest).changes) > 0;
      db.exec('COMMIT');
      return { ok: true, removed };
    }
    if (!current) {
      const count = Number((db.prepare('SELECT COUNT(*) AS count FROM map_contributions').get() as { count: number }).count);
      if (count >= MAP_CONTRIBUTION_CAP) {
        db.exec('COMMIT');
        return { ok: false, reason: 'full' };
      }
    }
    db.prepare('INSERT INTO map_contributions(visitor_digest, country_code, updated_at) VALUES (?, ?, ?) ON CONFLICT(visitor_digest) DO UPDATE SET country_code=excluded.country_code, updated_at=excluded.updated_at')
      .run(visitorDigest, countryCode, now);
    db.exec('COMMIT');
    return { ok: true, removed: false };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function removeMapContribution(db: DatabaseSync, visitorDigest: string): boolean {
  return Number(db.prepare('DELETE FROM map_contributions WHERE visitor_digest=?').run(visitorDigest).changes) > 0;
}
