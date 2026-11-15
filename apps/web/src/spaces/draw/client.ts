import {
  DRAWING_BRUSH_SIZES,
  DRAWING_HEIGHT,
  DRAWING_PALETTE,
  DRAWING_WIDTH,
  type DrawingStroke,
} from '../../../../../packages/shared/drawing.js';

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error('Missing Drawing Board element: ' + selector);
  return element;
}

const canvas = required<HTMLCanvasElement>('#draw-surface');
const createPanel = required<HTMLElement>('#create-panel');
const galleryPanel = required<HTMLElement>('#gallery-panel');
const gallery = required<HTMLDivElement>('#drawing-gallery');
const galleryEmpty = required<HTMLParagraphElement>('#gallery-empty');
const galleryFeedback = required<HTMLParagraphElement>('#gallery-feedback');
const feedback = required<HTMLParagraphElement>('#draw-feedback');
const keyboardStatus = required<HTMLSpanElement>('#draw-keyboard-status');
const submitButton = required<HTMLButtonElement>('#submit-drawing');
const undoButton = required<HTMLButtonElement>('#undo-drawing');
const redoButton = required<HTMLButtonElement>('#redo-drawing');
const olderButton = required<HTMLButtonElement>('#older-drawings');
const viewer = required<HTMLDialogElement>('#drawing-viewer');
const viewerCanvas = required<HTMLCanvasElement>('#viewer-surface');
const viewerTitle = required<HTMLHeadingElement>('#viewer-title');
const closeViewer = required<HTMLButtonElement>('#close-viewer');

type Tool = 'pen' | 'eraser';
interface DrawingRecord {
  readonly id: number;
  readonly createdAt: number;
  readonly strokes: readonly DrawingStroke[];
}
interface DrawingPage {
  readonly drawings: readonly DrawingRecord[];
  readonly nextBefore: number | null;
}

function context2d(target: HTMLCanvasElement): CanvasRenderingContext2D {
  const value = target.getContext('2d');
  if (!value) throw new Error('Canvas is unavailable');
  return value;
}
const context = context2d(canvas);
const viewerContext = context2d(viewerCanvas);

let strokes: DrawingStroke[] = [];
let redo: DrawingStroke[] = [];
let activeStroke: { tool: Tool; color: number; size: number; points: [number, number][] } | null = null;
let pointer: number | null = null;
let activeTool: Tool = 'pen';
let activeColor = 0;
let activeSize = 1;
let busy = false;
let nextBefore: number | null = null;
let keyboardX = DRAWING_WIDTH / 2;
let keyboardY = DRAWING_HEIGHT / 2;
let keyboardStroke: { tool: Tool; color: number; size: number; points: [number, number][] } | null = null;
let currentViewed: DrawingRecord | null = null;

function setFeedback(message: string, state = ''): void {
  feedback.textContent = message;
  feedback.dataset.state = state;
}

function setGalleryFeedback(message: string, state = ''): void {
  galleryFeedback.textContent = message;
  galleryFeedback.dataset.state = state;
}

function setCanvasSize(target: HTMLCanvasElement): void {
  const rect = target.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (target.width === width && target.height === height) return;
  target.width = width;
  target.height = height;
}

function paintStroke(target: CanvasRenderingContext2D, stroke: DrawingStroke, isViewer = false): void {
  target.save();
  target.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
  target.strokeStyle = DRAWING_PALETTE[stroke.color] ?? DRAWING_PALETTE[0];
  target.fillStyle = target.strokeStyle;
  target.lineWidth = DRAWING_BRUSH_SIZES[stroke.size] ?? DRAWING_BRUSH_SIZES[1];
  target.lineCap = 'round';
  target.lineJoin = 'round';
  const first = stroke.points[0];
  if (stroke.points.length === 1 && first) {
    target.beginPath();
    target.arc(first[0], first[1], target.lineWidth / 2, 0, Math.PI * 2);
    target.fill();
  } else {
    target.beginPath();
    target.moveTo(stroke.points[0]![0], stroke.points[0]![1]);
    for (let index = 1; index < stroke.points.length; index++) {
      const point = stroke.points[index]!;
      target.lineTo(point[0], point[1]);
    }
    target.stroke();
  }
  target.restore();
  void isViewer;
}

function redrawSurface(): void {
  setCanvasSize(canvas);
  const rect = canvas.getBoundingClientRect();
  context.setTransform(canvas.width / DRAWING_WIDTH, 0, 0, canvas.height / DRAWING_HEIGHT, 0, 0);
  context.clearRect(0, 0, DRAWING_WIDTH, DRAWING_HEIGHT);
  context.fillStyle = '#fff';
  context.fillRect(0, 0, DRAWING_WIDTH, DRAWING_HEIGHT);
  for (const stroke of strokes) paintStroke(context, stroke);
  if (canvas === document.activeElement) {
    const radius = Math.max(8, DRAWING_BRUSH_SIZES[activeSize] * 1.8);
    context.save();
    context.strokeStyle = '#62635f';
    context.lineWidth = 1.5;
    context.setLineDash([4, 4]);
    context.beginPath();
    context.arc(keyboardX, keyboardY, radius, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }
  void rect;
}

function renderDrawing(target: HTMLCanvasElement, targetContext: CanvasRenderingContext2D, drawing: DrawingRecord): void {
  setCanvasSize(target);
  targetContext.setTransform(target.width / DRAWING_WIDTH, 0, 0, target.height / DRAWING_HEIGHT, 0, 0);
  targetContext.clearRect(0, 0, DRAWING_WIDTH, DRAWING_HEIGHT);
  targetContext.fillStyle = '#fff';
  targetContext.fillRect(0, 0, DRAWING_WIDTH, DRAWING_HEIGHT);
  for (const stroke of drawing.strokes) paintStroke(targetContext, stroke, true);
}

function syncButtons(): void {
  undoButton.disabled = strokes.length === 0 || busy;
  redoButton.disabled = redo.length === 0 || busy;
  submitButton.disabled = strokes.length === 0 || busy;
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.tool === activeTool));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-color]').forEach(button => {
    button.setAttribute('aria-pressed', String(Number(button.dataset.color) === activeColor));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-size]').forEach(button => {
    button.setAttribute('aria-pressed', String(Number(button.dataset.size) === activeSize));
  });
}

function logicalPoint(event: PointerEvent): [number, number] {
  const rect = canvas.getBoundingClientRect();
  const x = Math.round(((event.clientX - rect.left) / rect.width) * DRAWING_WIDTH);
  const y = Math.round(((event.clientY - rect.top) / rect.height) * DRAWING_HEIGHT);
  return [Math.max(0, Math.min(DRAWING_WIDTH, x)), Math.max(0, Math.min(DRAWING_HEIGHT, y))];
}

function beginStroke(point: [number, number]): void {
  activeStroke = { tool: activeTool, color: activeColor, size: activeSize, points: [point] };
  strokes.push(activeStroke);
  redo = [];
  syncButtons();
  redrawSurface();
}

function extendStroke(point: [number, number]): void {
  if (!activeStroke) return;
  const previous = activeStroke.points.at(-1);
  if (!previous || Math.hypot(point[0] - previous[0], point[1] - previous[1]) >= 1.5) {
    activeStroke.points.push(point);
    redrawSurface();
  }
}

function finishStroke(): void {
  activeStroke = null;
  pointer = null;
  syncButtons();
  redrawSurface();
}

canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 || pointer !== null) return;
  event.preventDefault();
  pointer = event.pointerId;
  try { canvas.setPointerCapture(pointer); } catch { /* the stroke still ends on pointerup */ }
  beginStroke(logicalPoint(event));
});

canvas.addEventListener('pointermove', event => {
  if (pointer !== event.pointerId || !activeStroke) return;
  event.preventDefault();
  const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [event];
  for (const point of coalesced) extendStroke(logicalPoint(point));
});

canvas.addEventListener('pointerup', event => {
  if (pointer !== event.pointerId) return;
  event.preventDefault();
  finishStroke();
});
canvas.addEventListener('pointercancel', event => {
  if (pointer === event.pointerId) finishStroke();
});
canvas.addEventListener('lostpointercapture', event => {
  if (pointer === event.pointerId) finishStroke();
});

canvas.addEventListener('keydown', event => {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault();
    const step = event.shiftKey ? 25 : 10;
    if (event.key === 'ArrowLeft') keyboardX = Math.max(0, keyboardX - step);
    if (event.key === 'ArrowRight') keyboardX = Math.min(DRAWING_WIDTH, keyboardX + step);
    if (event.key === 'ArrowUp') keyboardY = Math.max(0, keyboardY - step);
    if (event.key === 'ArrowDown') keyboardY = Math.min(DRAWING_HEIGHT, keyboardY + step);
    keyboardStatus.textContent = 'Brush position ' + keyboardX + ', ' + keyboardY + '.';
    redrawSurface();
    return;
  }
  if (event.key === 'Escape' && keyboardStroke) {
    event.preventDefault();
    keyboardStroke = null;
    activeStroke = null;
    syncButtons();
    redrawSurface();
    keyboardStatus.textContent = 'Line ended.';
    return;
  }
  if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
    event.preventDefault();
    if (!keyboardStroke) {
      keyboardStroke = { tool: activeTool, color: activeColor, size: activeSize, points: [[keyboardX, keyboardY]] };
      strokes.push(keyboardStroke);
      redo = [];
      keyboardStatus.textContent = 'Line started. Move with arrow keys, then press Space to extend or Escape to end.';
    } else {
      keyboardStroke.points.push([keyboardX, keyboardY]);
      keyboardStatus.textContent = 'Line extended.';
    }
    activeStroke = keyboardStroke;
    syncButtons();
    redrawSurface();
  }
});
canvas.addEventListener('keyup', event => {
  if (event.key === ' ' || event.key === 'Enter') event.preventDefault();
});
canvas.addEventListener('blur', () => {
  if (keyboardStroke) {
    keyboardStroke = null;
    activeStroke = null;
    syncButtons();
    redrawSurface();
  }
});

document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(button => {
  button.addEventListener('click', () => {
    activeTool = button.dataset.tool === 'eraser' ? 'eraser' : 'pen';
    syncButtons();
    canvas.focus();
  });
});
document.querySelectorAll<HTMLButtonElement>('[data-color]').forEach(button => {
  button.addEventListener('click', () => {
    activeColor = Number(button.dataset.color);
    activeTool = 'pen';
    syncButtons();
  });
});
document.querySelectorAll<HTMLButtonElement>('[data-size]').forEach(button => {
  button.addEventListener('click', () => {
    activeSize = Number(button.dataset.size);
    syncButtons();
  });
});

undoButton.addEventListener('click', () => {
  if (activeStroke) finishStroke();
  keyboardStroke = null;
  const stroke = strokes.pop();
  if (stroke) redo.push(stroke);
  setFeedback(stroke ? 'Undone.' : '');
  syncButtons();
  redrawSurface();
});
redoButton.addEventListener('click', () => {
  const stroke = redo.pop();
  if (stroke) strokes.push(stroke);
  setFeedback(stroke ? 'Redone.' : '');
  syncButtons();
  redrawSurface();
});
document.querySelector<HTMLButtonElement>('#clear-drawing')?.addEventListener('click', () => {
  if (activeStroke) finishStroke();
  keyboardStroke = null;
  if (strokes.length) redo = [...strokes, ...redo];
  strokes = [];
  setFeedback('The paper is clear.');
  syncButtons();
  redrawSurface();
});

document.querySelector<HTMLButtonElement>('#create-view')?.addEventListener('click', () => {
  createPanel.hidden = false;
  galleryPanel.hidden = true;
  document.querySelector<HTMLButtonElement>('#create-view')?.setAttribute('aria-pressed', 'true');
  document.querySelector<HTMLButtonElement>('#gallery-view')?.setAttribute('aria-pressed', 'false');
  redrawSurface();
});

function createCard(drawing: DrawingRecord): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'drawing-card';
  button.setAttribute('aria-label', 'Open drawing ' + drawing.id);
  const thumb = document.createElement('canvas');
  thumb.width = DRAWING_WIDTH;
  thumb.height = DRAWING_HEIGHT;
  thumb.setAttribute('aria-hidden', 'true');
  button.append(thumb);
  const label = document.createElement('span');
  label.className = 'drawing-card-label';
  label.textContent = 'Drawing ' + drawing.id;
  button.append(label);
  button.addEventListener('click', () => {
    currentViewed = drawing;
    viewerTitle.textContent = 'Drawing ' + drawing.id;
    viewer.showModal();
    requestAnimationFrame(() => renderDrawing(viewerCanvas, viewerContext, drawing));
    closeViewer.focus();
  });
  requestAnimationFrame(() => renderDrawing(thumb, thumb.getContext('2d')!, drawing));
  return button;
}

async function loadDrawings(before: number | null, append: boolean): Promise<void> {
  olderButton.disabled = true;
  setGalleryFeedback('Looking for drawings…');
  try {
    const path = before === null ? '/api/draw/drawings' : '/api/draw/drawings?before=' + before;
    const response = await fetch(path, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Could not load drawings.');
    const page = await response.json() as DrawingPage;
    if (!append) gallery.replaceChildren();
    for (const drawing of page.drawings) gallery.append(createCard(drawing));
    nextBefore = page.nextBefore;
    olderButton.hidden = nextBefore === null;
    galleryEmpty.hidden = gallery.childElementCount !== 0;
    setGalleryFeedback('');
    if (page.drawings.length === 0 && gallery.childElementCount === 0) galleryEmpty.hidden = false;
  } catch (error) {
    setGalleryFeedback(error instanceof Error ? error.message : 'Could not load drawings.', 'error');
  } finally {
    olderButton.disabled = false;
  }
}

document.querySelector<HTMLButtonElement>('#gallery-view')?.addEventListener('click', () => {
  createPanel.hidden = true;
  galleryPanel.hidden = false;
  document.querySelector<HTMLButtonElement>('#create-view')?.setAttribute('aria-pressed', 'false');
  document.querySelector<HTMLButtonElement>('#gallery-view')?.setAttribute('aria-pressed', 'true');
  void loadDrawings(null, false);
});
olderButton.addEventListener('click', () => {
  if (nextBefore !== null) void loadDrawings(nextBefore, true);
});

submitButton.addEventListener('click', async () => {
  if (busy || strokes.length === 0) return;
  busy = true;
  syncButtons();
  setFeedback('Leaving your drawing…');
  try {
    const response = await fetch('/api/draw/drawings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ strokes }),
    });
    if (response.status === 429) {
      const result = await response.json() as { error?: string; retryAfterMs?: number };
      if (result.error === 'cooldown') {
        const minutes = Math.max(1, Math.ceil((result.retryAfterMs ?? 0) / 60_000));
        throw new Error('You can leave another drawing in about ' + minutes + ' minute' + (minutes === 1 ? '' : 's') + '.');
      }
      throw new Error('Please wait a moment and try again.');
    }
    if (!response.ok) throw new Error('The drawing could not be left. Your sketch is still here.');
    strokes = [];
    redo = [];
    setFeedback('Your drawing is here for others to find.', 'success');
    syncButtons();
    redrawSurface();
    createPanel.hidden = true;
    galleryPanel.hidden = false;
    document.querySelector<HTMLButtonElement>('#create-view')?.setAttribute('aria-pressed', 'false');
    document.querySelector<HTMLButtonElement>('#gallery-view')?.setAttribute('aria-pressed', 'true');
    await loadDrawings(null, false);
  } catch (error) {
    setFeedback(error instanceof Error ? error.message : 'The drawing could not be left.', 'error');
  } finally {
    busy = false;
    syncButtons();
  }
});

closeViewer.addEventListener('click', () => viewer.close());
viewer.addEventListener('click', event => {
  if (event.target === viewer) viewer.close();
});
window.addEventListener('resize', () => {
  redrawSurface();
  if (viewer.open && currentViewed) renderDrawing(viewerCanvas, viewerContext, currentViewed);
});

const resizeObserver = new ResizeObserver(() => redrawSurface());
resizeObserver.observe(canvas);
window.addEventListener('pagehide', () => resizeObserver.disconnect(), { once: true });
syncButtons();
redrawSurface();
