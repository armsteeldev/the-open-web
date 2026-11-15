import {
  DRAWING_BRUSH_SIZES,
  DRAWING_HEIGHT,
  DRAWING_MAX_BYTES,
  DRAWING_MAX_POINTS,
  DRAWING_MAX_POINTS_PER_STROKE,
  DRAWING_MAX_STROKES,
  DRAWING_PALETTE,
  DRAWING_WIDTH,
  type DrawingStroke,
  type ValidatedDrawing,
} from '../../../../../packages/shared/drawing.js';
import { hasOnlyKeys, isUuidV4 } from '../plain-text.js';

export type { DrawingStroke, ValidatedDrawing };

export function validateDrawing(input: unknown): { readonly ok: true; readonly value: ValidatedDrawing } | { readonly ok: false } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false };
  const record = input as Record<string, unknown>;
  if (!hasOnlyKeys(record, ['strokes', 'requestId']) || !Array.isArray(record.strokes)) return { ok: false };
  if (Object.hasOwn(record, 'requestId') && !isUuidV4(record.requestId)) return { ok: false };
  if (record.strokes.length < 1 || record.strokes.length > DRAWING_MAX_STROKES) return { ok: false };

  let totalPoints = 0;
  const strokes: DrawingStroke[] = [];
  for (const value of record.strokes) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
    const stroke = value as Record<string, unknown>;
    if (Object.keys(stroke).length !== 4 || !('tool' in stroke) || !('color' in stroke) || !('size' in stroke) || !('points' in stroke)) return { ok: false };
    if (stroke.tool !== 'pen' && stroke.tool !== 'eraser') return { ok: false };
    if (!Number.isInteger(stroke.color) || Number(stroke.color) < 0 || Number(stroke.color) >= DRAWING_PALETTE.length) return { ok: false };
    if (!Number.isInteger(stroke.size) || Number(stroke.size) < 0 || Number(stroke.size) >= DRAWING_BRUSH_SIZES.length) return { ok: false };
    if (!Array.isArray(stroke.points) || stroke.points.length < 1 || stroke.points.length > DRAWING_MAX_POINTS_PER_STROKE) return { ok: false };
    totalPoints += stroke.points.length;
    if (totalPoints > DRAWING_MAX_POINTS) return { ok: false };

    const points: [number, number][] = [];
    for (const point of stroke.points) {
      if (!Array.isArray(point) || point.length !== 2) return { ok: false };
      const [x, y] = point;
      if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return { ok: false };
      if ((x as number) < 0 || (x as number) > DRAWING_WIDTH || (y as number) < 0 || (y as number) > DRAWING_HEIGHT) return { ok: false };
      points.push([x as number, y as number]);
    }
    strokes.push({ tool: stroke.tool, color: Number(stroke.color), size: Number(stroke.size), points });
  }

  const requestId = typeof record.requestId === 'string' ? record.requestId.toLowerCase() : undefined;
  const serializedRequest = JSON.stringify({ ...(requestId ? { requestId } : {}), strokes });
  if (Buffer.byteLength(serializedRequest, 'utf8') > DRAWING_MAX_BYTES) return { ok: false };
  const serialized = JSON.stringify(strokes);
  return { ok: true, value: { strokes, serialized, ...(requestId ? { requestId } : {}) } };
}

export function validateDrawingId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,11}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

export function validateDrawingCursor(value: unknown): number | null | false {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,11}$/.test(value)) return false;
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) ? cursor : false;
}
