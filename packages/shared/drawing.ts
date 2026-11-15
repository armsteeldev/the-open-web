export const DRAWING_WIDTH = 1000;
export const DRAWING_HEIGHT = 700;
export const DRAWING_PALETTE = ['#262626', '#e05a47', '#e3ad35', '#418b67', '#4d77b5', '#8b64a8'] as const;
export const DRAWING_BRUSH_SIZES = [2, 5, 10] as const;
export const DRAWING_MAX_STROKES = 60;
export const DRAWING_MAX_POINTS = 1000;
export const DRAWING_MAX_POINTS_PER_STROKE = 120;
export const DRAWING_MAX_BYTES = 20_000;

export interface DrawingStroke {
  readonly tool: 'pen' | 'eraser';
  readonly color: number;
  readonly size: number;
  readonly points: readonly (readonly [number, number])[];
}

export interface ValidatedDrawing {
  readonly strokes: readonly DrawingStroke[];
  readonly serialized: string;
}
