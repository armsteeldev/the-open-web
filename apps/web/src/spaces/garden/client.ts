import {
  GARDEN_COLUMNS,
  GARDEN_PLANT_TYPES,
  GARDEN_ROWS,
  type GardenPlantType,
  type GardenStage,
} from '../../../../../packages/shared/garden.js';

interface Plant {
  readonly x: number;
  readonly y: number;
  readonly plantType: GardenPlantType;
  readonly stage: GardenStage;
}
interface GardenState {
  readonly columns: number;
  readonly rows: number;
  readonly capacity: number;
  readonly plants: readonly Plant[];
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error('Missing Garden element: ' + selector);
  return element;
}
function context2d(target: HTMLCanvasElement): CanvasRenderingContext2D {
  const value = target.getContext('2d');
  if (!value) throw new Error('Canvas is unavailable');
  return value;
}

const canvas = required<HTMLCanvasElement>('#garden-scene');
const locationSelect = required<HTMLSelectElement>('#plant-location');
const plantSelect = required<HTMLSelectElement>('#plant-type');
const form = required<HTMLFormElement>('#plant-form');
const submit = required<HTMLButtonElement>('#plant-submit');
const feedback = required<HTMLParagraphElement>('#plant-feedback');
const count = required<HTMLParagraphElement>('#garden-count');
const list = required<HTMLUListElement>('#garden-list');
const context = context2d(canvas);
let state: GardenState = { columns: GARDEN_COLUMNS, rows: GARDEN_ROWS, capacity: GARDEN_COLUMNS * GARDEN_ROWS, plants: [] };
let busy = false;
let selectedPlot: { x: number; y: number } | null = null;

const plantNames: Record<GardenPlantType, string> = {
  clover: 'clover',
  wildflower: 'wildflower',
  sunflower: 'sunflower',
  grass: 'grass',
  sapling: 'sapling',
};
const stageNames: Record<GardenStage, string> = {
  seed: 'seed',
  sprout: 'sprout',
  young: 'young plant',
  mature: 'mature plant',
};

function plotKey(x: number, y: number): string {
  return x + ',' + y;
}

function isOpen(x: number, y: number): boolean {
  return !state.plants.some(plant => plant.x === x && plant.y === y);
}

function selectedFromInput(): { x: number; y: number } | null {
  const [xText, yText] = locationSelect.value.split(',');
  const x = Number(xText);
  const y = Number(yText);
  return Number.isInteger(x) && Number.isInteger(y) && isOpen(x, y) ? { x, y } : null;
}

function drawLeaf(target: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, angle: number, color: string): void {
  target.save();
  target.translate(x, y);
  target.rotate(angle);
  target.fillStyle = color;
  target.beginPath();
  target.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  target.fill();
  target.restore();
}

function drawPetals(target: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string, center: string): void {
  target.fillStyle = color;
  for (let index = 0; index < 8; index++) {
    const angle = index * Math.PI / 4;
    target.beginPath();
    target.ellipse(x + Math.cos(angle) * radius * 0.9, y + Math.sin(angle) * radius * 0.9, radius * 0.42, radius * 0.2, angle, 0, Math.PI * 2);
    target.fill();
  }
  target.fillStyle = center;
  target.beginPath();
  target.arc(x, y, radius * 0.3, 0, Math.PI * 2);
  target.fill();
}

function drawPlant(target: CanvasRenderingContext2D, plant: Plant): void {
  const x = 54 + plant.x * 52.5;
  const baseline = 448 - plant.y * 31;
  const perspective = 0.62 + (GARDEN_ROWS - 1 - plant.y) * 0.042;
  const stageScale: Record<GardenStage, number> = { seed: 0.2, sprout: 0.38, young: 0.68, mature: 1 };
  const scale = perspective * stageScale[plant.stage];
  target.save();
  target.translate(x, baseline);
  target.scale(scale, scale);
  target.fillStyle = '#72765c66';
  target.beginPath();
  target.ellipse(0, 2, 17, 4, 0, 0, Math.PI * 2);
  target.fill();

  if (plant.stage === 'seed') {
    target.fillStyle = '#765b3a';
    target.beginPath();
    target.ellipse(0, -4, 4, 3, -0.3, 0, Math.PI * 2);
    target.fill();
    target.restore();
    return;
  }

  const top = plant.stage === 'sprout' ? -19 : plant.stage === 'young' ? -39 : -64;
  target.strokeStyle = '#486f4e';
  target.lineWidth = 3;
  target.lineCap = 'round';
  target.beginPath();
  target.moveTo(0, 0);
  target.quadraticCurveTo(-2, top * 0.55, 0, top);
  target.stroke();

  if (plant.stage === 'sprout') {
    drawLeaf(target, -7, top * 0.58, 8, 4, -0.48, '#6f9868');
    drawLeaf(target, 7, top * 0.8, 8, 4, 0.48, '#88a879');
    target.restore();
    return;
  }

  drawLeaf(target, -9, top * 0.48, 11, 5, -0.48, '#6e9568');
  drawLeaf(target, 10, top * 0.68, 11, 5, 0.46, '#87a776');
  if (plant.stage === 'young') {
    target.restore();
    return;
  }

  if (plant.plantType === 'grass') {
    target.strokeStyle = '#587d51';
    target.lineWidth = 3;
    for (const [side, height] of [[-1, 48], [-0.5, 57], [0.5, 53], [1, 44]] as const) {
      target.beginPath();
      target.moveTo(0, 0);
      target.quadraticCurveTo(side * 7, -height * 0.6, side * 12, -height);
      target.stroke();
    }
  } else if (plant.plantType === 'sapling') {
    target.strokeStyle = '#795d43';
    target.lineWidth = 5;
    target.beginPath();
    target.moveTo(0, 0);
    target.lineTo(0, -48);
    target.stroke();
    target.fillStyle = '#5f8055';
    for (const [cx, cy, radius] of [[-7, -47, 16], [8, -49, 18], [0, -64, 16]] as const) {
      target.beginPath();
      target.arc(cx, cy, radius, 0, Math.PI * 2);
      target.fill();
    }
  } else if (plant.plantType === 'wildflower') {
    drawPetals(target, 0, top, 12, '#d9a756', '#765a3b');
  } else if (plant.plantType === 'sunflower') {
    drawPetals(target, 0, top, 17, '#e3bb4d', '#58452f');
  } else {
    drawLeaf(target, -7, top - 5, 8, 6, -0.4, '#659268');
    drawLeaf(target, 7, top - 5, 8, 6, 0.4, '#7fa276');
    drawPetals(target, 0, top - 10, 7, '#e28b83', '#d9b367');
  }
  target.restore();
}

function drawScene(): void {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.setTransform(canvas.width / 1000, 0, 0, canvas.height / 560, 0, 0);
  const sky = context.createLinearGradient(0, 0, 0, 360);
  sky.addColorStop(0, '#dce6d9');
  sky.addColorStop(1, '#c7d3c4');
  context.fillStyle = sky;
  context.fillRect(0, 0, 1000, 560);
  context.fillStyle = '#b7c2a8';
  context.beginPath();
  context.moveTo(0, 324);
  context.quadraticCurveTo(210, 292, 420, 328);
  context.quadraticCurveTo(715, 366, 1000, 310);
  context.lineTo(1000, 560);
  context.lineTo(0, 560);
  context.closePath();
  context.fill();
  context.strokeStyle = '#a1ad94';
  context.lineWidth = 1;
  for (let row = 0; row < GARDEN_ROWS; row++) {
    const baseline = 448 - row * 31;
    context.beginPath();
    context.moveTo(24, baseline + 5);
    context.quadraticCurveTo(500, baseline + 16, 976, baseline + 4);
    context.stroke();
  }
  for (let column = 0; column < GARDEN_COLUMNS; column++) {
    const x = 54 + column * 52.5;
    for (let row = 0; row < GARDEN_ROWS; row++) {
      const baseline = 448 - row * 31;
      context.fillStyle = '#89977726';
      context.beginPath();
      context.ellipse(x, baseline + 1, 16, 4, 0, 0, Math.PI * 2);
      context.fill();
    }
  }

  const selected = selectedPlot ?? selectedFromInput();
  if (selected) {
    const x = 54 + selected.x * 52.5;
    const baseline = 448 - selected.y * 31;
    context.save();
    context.strokeStyle = '#485d43';
    context.lineWidth = 2;
    context.setLineDash([4, 4]);
    context.beginPath();
    context.ellipse(x, baseline + 1, 19, 7, 0, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }
  for (const plant of [...state.plants].sort((a, b) => b.y - a.y || a.x - b.x)) drawPlant(context, plant);
  if (state.plants.length === 0) {
    context.fillStyle = '#65735f';
    context.font = '16px system-ui, sans-serif';
    context.textAlign = 'center';
    context.fillText('A quiet patch of ground', 500, 280);
  }
}

function updateLocations(): void {
  const previous = locationSelect.value;
  locationSelect.replaceChildren();
  const available: { x: number; y: number }[] = [];
  for (let y = 0; y < GARDEN_ROWS; y++) {
    for (let x = 0; x < GARDEN_COLUMNS; x++) if (isOpen(x, y)) available.push({ x, y });
  }
  if (!available.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'The garden is full';
    locationSelect.append(option);
    locationSelect.disabled = true;
    submit.disabled = true;
    selectedPlot = null;
    return;
  }
  locationSelect.disabled = busy;
  submit.disabled = busy;
  for (const plot of available) {
    const option = document.createElement('option');
    option.value = plotKey(plot.x, plot.y);
    option.textContent = 'Patch ' + (plot.x + 1) + ', row ' + (plot.y + 1);
    locationSelect.append(option);
  }
  if (available.some(plot => plotKey(plot.x, plot.y) === previous)) locationSelect.value = previous;
  else locationSelect.value = plotKey(available[0]!.x, available[0]!.y);
  selectedPlot = selectedFromInput();
}

function updateList(): void {
  list.replaceChildren();
  for (const plant of state.plants) {
    const item = document.createElement('li');
    item.textContent = 'A ' + stageNames[plant.stage] + ' ' + plantNames[plant.plantType] + ' in patch ' + (plant.x + 1) + ', row ' + (plant.y + 1) + '.';
    list.append(item);
  }
  if (!state.plants.length) {
    const item = document.createElement('li');
    item.textContent = 'Nothing has been planted yet.';
    list.append(item);
  }
  const countText = state.plants.length === 0
    ? 'A shared patch of ground'
    : state.plants.length + (state.plants.length === 1 ? ' plant growing' : ' plants growing');
  count.textContent = countText;
  canvas.setAttribute('aria-label', countText + '. Choose a plant and open patch below to add one.');
}

function render(next: GardenState): void {
  state = next;
  updateLocations();
  updateList();
  drawScene();
}

async function loadGarden(): Promise<void> {
  try {
    const response = await fetch('/api/garden/state', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('The garden is hard to reach. Try again in a moment.');
    render(await response.json() as GardenState);
  } catch (error) {
    feedback.textContent = error instanceof Error ? error.message : 'The garden is hard to reach.';
    feedback.dataset.state = 'error';
  }
}

locationSelect.addEventListener('change', drawScene);
canvas.addEventListener('click', event => {
  const rect = canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * 1000;
  const y = ((event.clientY - rect.top) / rect.height) * 560;
  const column = Math.round((x - 54) / 52.5);
  const row = Math.round((448 - y) / 31);
  if (column < 0 || column >= GARDEN_COLUMNS || row < 0 || row >= GARDEN_ROWS) return;
  const centerX = 54 + column * 52.5;
  const centerY = 448 - row * 31;
  if (Math.abs(x - centerX) > 24 || Math.abs(y - centerY) > 15) return;
  if (!isOpen(column, row)) {
    feedback.textContent = 'That patch already has a plant. Choose one of the open patches.';
    feedback.dataset.state = '';
    return;
  }
  locationSelect.value = plotKey(column, row);
  selectedPlot = { x: column, y: row };
  feedback.textContent = 'Patch ' + (column + 1) + ', row ' + (row + 1) + ' selected.';
  feedback.dataset.state = '';
  drawScene();
  locationSelect.focus({ preventScroll: true });
});

plantSelect.addEventListener('change', () => {
  feedback.dataset.state = '';
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const plot = selectedFromInput();
  if (!plot || !(GARDEN_PLANT_TYPES as readonly string[]).includes(plantSelect.value)) {
    feedback.textContent = 'Choose an open patch and a plant.';
    feedback.dataset.state = 'error';
    return;
  }
  busy = true;
  submit.disabled = true;
  locationSelect.disabled = true;
  plantSelect.disabled = true;
  feedback.textContent = 'Planting…';
  feedback.dataset.state = '';
  try {
    const response = await fetch('/api/garden/plants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x: plot.x, y: plot.y, plantType: plantSelect.value }),
    });
    if (response.status === 429) {
      const result = await response.json() as { error?: string; retryAfterMs?: number };
      if (result.error === 'cooldown') {
        const minutes = Math.max(1, Math.ceil((result.retryAfterMs ?? 0) / 60_000));
        throw new Error('You can plant something else in about ' + minutes + ' minute' + (minutes === 1 ? '' : 's') + '.');
      }
      throw new Error('Please wait a moment and try again.');
    }
    if (response.status === 409) {
      const result = await response.json() as { error?: string };
      await loadGarden();
      throw new Error(result.error === 'garden full'
        ? 'The garden is full. A patch opens when an older plant leaves.'
        : 'That patch is already occupied. Choose another one.');
    }
    if (!response.ok) throw new Error('Your plant did not take. Try again.');
    const plant = await response.json() as { plant: Plant };
    const display = plantNames[plant.plant.plantType];
    const location = 'patch ' + (plant.plant.x + 1) + ', row ' + (plant.plant.y + 1);
    await loadGarden();
    feedback.textContent = 'You planted a ' + display + ' in ' + location + '. It will grow with time.';
    feedback.dataset.state = '';
  } catch (error) {
    feedback.textContent = error instanceof Error ? error.message : 'Your plant did not take. Try again.';
    feedback.dataset.state = 'error';
  } finally {
    busy = false;
    plantSelect.disabled = false;
    updateLocations();
    drawScene();
  }
});

const resizeObserver = new ResizeObserver(drawScene);
resizeObserver.observe(canvas);
window.addEventListener('resize', drawScene);
window.addEventListener('pagehide', () => resizeObserver.disconnect(), { once: true });
void loadGarden();
