import {
  GARDEN_COLUMNS,
  GARDEN_PLANT_TYPES,
  GARDEN_ROWS,
  type GardenPlantType,
} from '../../../../../packages/shared/garden.js';

export { GARDEN_COLUMNS, GARDEN_PLANT_TYPES, GARDEN_ROWS };
export type { GardenPlantType };

export interface ValidatedPlanting {
  readonly x: number;
  readonly y: number;
  readonly plantType: GardenPlantType;
}

export function validatePlanting(input: unknown): ValidatedPlanting | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (Object.keys(record).length !== 3 || !('x' in record) || !('y' in record) || !('plantType' in record)) return null;
  if (!Number.isInteger(record.x) || !Number.isInteger(record.y)) return null;
  if ((record.x as number) < 0 || (record.x as number) >= GARDEN_COLUMNS || (record.y as number) < 0 || (record.y as number) >= GARDEN_ROWS) return null;
  if (typeof record.plantType !== 'string' || !(GARDEN_PLANT_TYPES as readonly string[]).includes(record.plantType)) return null;
  return { x: record.x as number, y: record.y as number, plantType: record.plantType as GardenPlantType };
}
