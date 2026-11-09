export const SIZE = 2000;
export const TILE = 100;
export const PALETTE = ['#ffffff','#e4e4e4','#888888','#222222','#e53935','#ff9800','#ffeb3b','#8bc34a','#258b45','#00bcd4','#1976d2','#3949ab','#8e44ad','#ec407a','#a5683c','#f5cba7'] as const;
export const COLOR_NAMES = ['White','Light grey','Grey','Charcoal','Red','Orange','Yellow','Light green','Green','Cyan','Blue','Indigo','Purple','Pink','Brown','Peach'] as const;
export function validPixel(x: unknown,y: unknown,color: unknown): x is number { return Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(color) && (x as number)>=0 && (x as number)<SIZE && (y as number)>=0 && (y as number)<SIZE && (color as number)>=0 && (color as number)<PALETTE.length; }
