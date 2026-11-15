import type { DatabaseSync } from 'node:sqlite';
import type { GardenStage } from '../../../../../packages/shared/garden.js';
import { GARDEN_COLUMNS, GARDEN_ROWS, type GardenPlantType, type ValidatedPlanting } from './validation.js';

export const GARDEN_CAPACITY = GARDEN_COLUMNS * GARDEN_ROWS;
export const GARDEN_PLANT_COOLDOWN_MS = 30 * 60 * 1000;
export const GARDEN_PLANT_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
export const GARDEN_VISITOR_CAP = 50_000;
export const GARDEN_GROWTH = Object.freeze({
  sprout: 60 * 1000,
  young: 30 * 60 * 1000,
  mature: 24 * 60 * 60 * 1000,
});

export interface GardenPlant {
  readonly x: number;
  readonly y: number;
  readonly plantType: GardenPlantType;
  readonly stage: GardenStage;
}
interface GardenPlantRow {
  x: number;
  y: number;
  plant_type: GardenPlantType;
  created_at: number;
  id: number;
}

export function gardenStage(createdAt: number, now: number): GardenStage | null {
  const age = Math.max(0, now - createdAt);
  if (age >= GARDEN_PLANT_LIFETIME_MS) return null;
  if (age < GARDEN_GROWTH.sprout) return 'seed';
  if (age < GARDEN_GROWTH.young) return 'sprout';
  if (age < GARDEN_GROWTH.mature) return 'young';
  return 'mature';
}

function removeExpiredPlants(db: DatabaseSync, now: number): number {
  return Number(db.prepare('DELETE FROM garden_plants WHERE created_at<=?').run(now - GARDEN_PLANT_LIFETIME_MS).changes);
}

export function readGarden(db: DatabaseSync, now = Date.now()): {
  readonly columns: number;
  readonly rows: number;
  readonly capacity: number;
  readonly plants: readonly GardenPlant[];
} {
  removeExpiredPlants(db, now);
  const rows = db.prepare('SELECT id, x, y, plant_type, created_at FROM garden_plants ORDER BY y, x, id').all() as unknown as GardenPlantRow[];
  const plants = rows.flatMap(row => {
    const stage = gardenStage(row.created_at, now);
    return stage === null ? [] : [{ x: row.x, y: row.y, plantType: row.plant_type, stage }];
  });
  return { columns: GARDEN_COLUMNS, rows: GARDEN_ROWS, capacity: GARDEN_CAPACITY, plants };
}

export type PlantResult =
  | { readonly ok: true; readonly plant: GardenPlant }
  | { readonly ok: false; readonly reason: 'cooldown'; readonly retryAfterMs: number }
  | { readonly ok: false; readonly reason: 'occupied' | 'full' };

export function plantAt(
  db: DatabaseSync,
  visitorDigest: string,
  planting: ValidatedPlanting,
  now = Date.now(),
): PlantResult {
  db.exec('BEGIN IMMEDIATE');
  try {
    removeExpiredPlants(db, now);
    const last = db.prepare('SELECT planted_at FROM garden_visitor_cooldowns WHERE visitor_digest=?')
      .get(visitorDigest) as { planted_at: number } | undefined;
    if (last && last.planted_at + GARDEN_PLANT_COOLDOWN_MS > now) {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'cooldown', retryAfterMs: last.planted_at + GARDEN_PLANT_COOLDOWN_MS - now };
    }

    const count = Number((db.prepare('SELECT COUNT(*) AS count FROM garden_plants').get() as { count: number }).count);
    if (count >= GARDEN_CAPACITY) {
      db.exec('COMMIT');
      return { ok: false, reason: 'full' };
    }
    if (db.prepare('SELECT 1 FROM garden_plants WHERE x=? AND y=?').get(planting.x, planting.y)) {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'occupied' };
    }

    db.prepare('INSERT INTO garden_plants(x, y, plant_type, created_at) VALUES (?, ?, ?, ?)')
      .run(planting.x, planting.y, planting.plantType, now);
    db.prepare('INSERT INTO garden_visitor_cooldowns(visitor_digest, planted_at) VALUES (?, ?) ON CONFLICT(visitor_digest) DO UPDATE SET planted_at=excluded.planted_at')
      .run(visitorDigest, now);
    db.prepare('DELETE FROM garden_visitor_cooldowns WHERE planted_at<=?').run(now - GARDEN_PLANT_COOLDOWN_MS);
    db.prepare('DELETE FROM garden_visitor_cooldowns WHERE rowid IN (SELECT rowid FROM garden_visitor_cooldowns ORDER BY planted_at DESC, rowid DESC LIMIT -1 OFFSET ?)')
      .run(GARDEN_VISITOR_CAP);
    db.exec('COMMIT');
    return {
      ok: true,
      plant: { x: planting.x, y: planting.y, plantType: planting.plantType, stage: 'seed' },
    };
  } catch (error) {
    db.exec('ROLLBACK');
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed: garden_plants.x, garden_plants.y')) {
      return { ok: false, reason: 'occupied' };
    }
    throw error;
  }
}

export function cleanupGarden(db: DatabaseSync, now = Date.now()): number {
  const plants = removeExpiredPlants(db, now);
  const cooldowns = db.prepare('DELETE FROM garden_visitor_cooldowns WHERE planted_at<=?').run(now - GARDEN_PLANT_COOLDOWN_MS);
  return plants + Number(cooldowns.changes);
}

export function removePlant(db: DatabaseSync, id: number): boolean {
  return Number(db.prepare('DELETE FROM garden_plants WHERE id=?').run(id).changes) > 0;
}
