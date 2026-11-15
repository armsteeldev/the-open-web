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
const retry = required<HTMLButtonElement>('#garden-retry');
const count = required<HTMLParagraphElement>('#garden-count');
const list = required<HTMLUListElement>('#garden-list');
const context = context2d(canvas);
let state: GardenState = { columns: GARDEN_COLUMNS, rows: GARDEN_ROWS, capacity: GARDEN_COLUMNS * GARDEN_ROWS, plants: [] };
let busy = false;
let loaded = false;
locationSelect.disabled = true;
plantSelect.disabled = true;
submit.disabled = true;

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

function stableUnit(seed: number): number {
  let value = seed | 0;
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return ((value ^ (value >>> 16)) >>> 0) / 0x1_0000_0000;
}

function plantVariation(plant: Plant, channel: number): number {
  let seed = Math.imul(plant.x + 1, 0x9e3779b1) ^ Math.imul(plant.y + 1, 0x85ebca6b) ^ Math.imul(channel + 1, 0xc2b2ae35);
  for (const character of plant.plantType) seed = Math.imul(seed ^ character.charCodeAt(0), 0x27d4eb2d);
  return stableUnit(seed);
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

function drawPetals(target: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string, center: string, count = 8, rotation = 0): void {
  target.fillStyle = color;
  for (let index = 0; index < count; index++) {
    const angle = rotation + index * Math.PI * 2 / count;
    target.beginPath();
    target.ellipse(x + Math.cos(angle) * radius * 0.82, y + Math.sin(angle) * radius * 0.82, radius * 0.43, radius * (0.18 + (index % 2) * 0.035), angle, 0, Math.PI * 2);
    target.fill();
  }
  target.fillStyle = center;
  target.beginPath();
  target.arc(x, y, radius * 0.3, 0, Math.PI * 2);
  target.fill();
}

function drawPlant(target: CanvasRenderingContext2D, plant: Plant): void {
  const x = 54 + plant.x * 52.5 + (plantVariation(plant, 0) - 0.5) * 15;
  const baseline = 448 - plant.y * 31 + (plantVariation(plant, 1) - 0.5) * 7;
  const perspective = 0.62 + (GARDEN_ROWS - 1 - plant.y) * 0.042;
  const stageScale: Record<GardenStage, number> = { seed: 0.2, sprout: 0.38, young: 0.68, mature: 1 };
  const scale = perspective * stageScale[plant.stage] * (0.94 + plantVariation(plant, 2) * 0.12);
  const lean = (plantVariation(plant, 3) - 0.5) * 15;
  const leafAngle = (plantVariation(plant, 4) - 0.5) * 0.35;
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

  const baseTop = plant.stage === 'sprout' ? -19 : plant.stage === 'young' ? -39 : -64;
  const top = baseTop * (0.94 + plantVariation(plant, 5) * 0.14);
  target.strokeStyle = plantVariation(plant, 6) > 0.5 ? '#486f4e' : '#517652';
  target.lineWidth = 2.4 + plantVariation(plant, 7) * 1.2;
  target.lineCap = 'round';
  target.beginPath();
  target.moveTo(0, 0);
  target.quadraticCurveTo(lean * 0.42, top * 0.52, lean, top);
  target.stroke();

  if (plant.stage === 'sprout') {
    drawLeaf(target, lean * 0.5 - 7, top * (0.56 + plantVariation(plant, 8) * 0.12), 7 + plantVariation(plant, 9) * 2, 3.5, -0.48 - leafAngle, '#6f9868');
    drawLeaf(target, lean * 0.72 + 7, top * (0.76 + plantVariation(plant, 10) * 0.12), 7 + plantVariation(plant, 11) * 2, 3.5, 0.48 + leafAngle, '#88a879');
    target.restore();
    return;
  }

  drawLeaf(target, lean * 0.5 - 9, top * (0.46 + plantVariation(plant, 12) * 0.12), 9 + plantVariation(plant, 13) * 3, 4.5, -0.5 - leafAngle, '#6e9568');
  drawLeaf(target, lean * 0.72 + 10, top * (0.64 + plantVariation(plant, 14) * 0.12), 9 + plantVariation(plant, 15) * 3, 4.5, 0.44 + leafAngle, '#87a776');
  if (plant.stage === 'young') {
    target.restore();
    return;
  }

  if (plant.plantType === 'grass') {
    target.strokeStyle = plantVariation(plant, 16) > 0.5 ? '#587d51' : '#688957';
    target.lineWidth = 2 + plantVariation(plant, 17) * 1.5;
    const tuftHeight = 42 + plantVariation(plant, 18) * 18;
    for (const [index, side] of ([-1, -0.5, 0.15, 0.72, 1] as const).entries()) {
      const height = tuftHeight * (0.78 + plantVariation(plant, 19 + index) * 0.32);
      const bend = (plantVariation(plant, 25 + index) - 0.5) * 9;
      target.beginPath();
      target.moveTo(0, 0);
      target.quadraticCurveTo(side * 7 + bend, -height * 0.6, side * 12 + bend, -height);
      target.stroke();
    }
  } else if (plant.plantType === 'sapling') {
    target.strokeStyle = plantVariation(plant, 31) > 0.5 ? '#795d43' : '#88684b';
    target.lineWidth = 4 + plantVariation(plant, 32) * 2;
    target.beginPath();
    target.moveTo(0, 0);
    target.lineTo(lean * 0.7, -48);
    target.stroke();
    target.fillStyle = plantVariation(plant, 33) > 0.5 ? '#5f8055' : '#69895e';
    const crown = [
      [-8 + (plantVariation(plant, 34) - 0.5) * 7, -46, 14 + plantVariation(plant, 35) * 5],
      [8 + (plantVariation(plant, 36) - 0.5) * 7, -49, 14 + plantVariation(plant, 37) * 6],
      [lean * 0.65, -63 - plantVariation(plant, 38) * 5, 13 + plantVariation(plant, 39) * 5],
    ] as const;
    for (const [cx, cy, radius] of crown) {
      target.beginPath();
      target.arc(cx, cy, radius, 0, Math.PI * 2);
      target.fill();
    }
  } else if (plant.plantType === 'wildflower') {
    const colors = ['#d9a756', '#d98770', '#d6c06e', '#b7a6c6'];
    drawPetals(target, lean, top, 10 + plantVariation(plant, 40) * 5, colors[Math.floor(plantVariation(plant, 41) * colors.length)]!, '#765a3b', 7 + Math.floor(plantVariation(plant, 42) * 4), plantVariation(plant, 43) * 0.5);
  } else if (plant.plantType === 'sunflower') {
    const golds = ['#e3bb4d', '#e0aa3f', '#edc85d'];
    drawPetals(target, lean, top, 14 + plantVariation(plant, 44) * 5, golds[Math.floor(plantVariation(plant, 45) * golds.length)]!, '#58452f', 9 + Math.floor(plantVariation(plant, 46) * 4), plantVariation(plant, 47) * 0.45);
  } else {
    drawLeaf(target, lean - 7, top - 5, 7 + plantVariation(plant, 48) * 2, 5, -0.4 - leafAngle, '#659268');
    drawLeaf(target, lean + 7, top - 5, 7 + plantVariation(plant, 49) * 2, 5, 0.4 + leafAngle, '#7fa276');
    const pinks = ['#e28b83', '#cf7c76', '#df9b70'];
    drawPetals(target, lean, top - 10, 6 + plantVariation(plant, 50) * 2, pinks[Math.floor(plantVariation(plant, 51) * pinks.length)]!, '#d9b367', 6 + Math.floor(plantVariation(plant, 52) * 3), plantVariation(plant, 53) * 0.6);
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
  context.strokeStyle = '#91a08755';
  context.lineWidth = 0.8;
  for (let row = 1; row < GARDEN_ROWS; row += 2) {
    const baseline = 448 - row * 31;
    context.beginPath();
    context.moveTo(24, baseline + 5);
    context.quadraticCurveTo(240, baseline + 15, 492, baseline + 6);
    context.quadraticCurveTo(748, baseline - 1, 976, baseline + 4);
    context.stroke();
  }
  for (let index = 0; index < 30; index++) {
    const x = 24 + stableUnit(index * 23 + 701) * 952;
    const y = 340 + stableUnit(index * 31 + 907) * 204;
    const radiusX = 12 + stableUnit(index * 19 + 121) * 28;
    const radiusY = 2 + stableUnit(index * 17 + 441) * 6;
    context.fillStyle = index % 3 === 0 ? '#87987818' : '#d0d5bb20';
    context.beginPath();
    context.ellipse(x, y, radiusX, radiusY, (stableUnit(index * 37 + 8) - 0.5) * 0.16, 0, Math.PI * 2);
    context.fill();
  }
  for (let index = 0; index < 104; index++) {
    const x = 18 + stableUnit(index * 47 + 1337) * 964;
    const y = 336 + stableUnit(index * 53 + 2243) * 210;
    const length = 2 + stableUnit(index * 29 + 78) * 5;
    context.strokeStyle = index % 3 === 0 ? '#647c571f' : '#e2e2c51f';
    context.lineWidth = 0.6 + stableUnit(index * 41 + 619) * 0.6;
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x + length, y - 1 - stableUnit(index * 43 + 601) * 2);
    context.stroke();
  }

  const selected = selectedFromInput();
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
    plantSelect.disabled = true;
    return;
  }
  locationSelect.disabled = busy || !loaded;
  submit.disabled = busy || !loaded;
  plantSelect.disabled = busy || !loaded;
  for (const plot of available) {
    const option = document.createElement('option');
    option.value = plotKey(plot.x, plot.y);
    option.textContent = 'Patch ' + (plot.x + 1) + ', row ' + (plot.y + 1);
    locationSelect.append(option);
  }
  if (available.some(plot => plotKey(plot.x, plot.y) === previous)) locationSelect.value = previous;
  else locationSelect.value = plotKey(available[0]!.x, available[0]!.y);
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

async function loadGarden(): Promise<boolean> {
  if (!loaded) {
    feedback.textContent = 'Opening the garden…';
    feedback.dataset.state = '';
  }
  retry.disabled = true;
  try {
    const response = await fetch('/api/garden/state', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('The garden is hard to reach. Try again in a moment.');
    const next = await response.json() as GardenState;
    loaded = true;
    retry.hidden = true;
    render(next);
    return true;
  } catch (error) {
    feedback.textContent = error instanceof Error ? error.message : 'The garden is hard to reach.';
    feedback.dataset.state = 'error';
    retry.hidden = false;
    return false;
  } finally {
    retry.disabled = false;
  }
}

retry.addEventListener('click', () => { void loadGarden(); });
locationSelect.addEventListener('change', drawScene);
canvas.addEventListener('click', event => {
  if (!loaded) {
    feedback.textContent = 'The garden is still opening. Choose a patch when it appears.';
    feedback.dataset.state = '';
    return;
  }
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
  if (!loaded) {
    feedback.textContent = 'The garden is still opening. Try again in a moment.';
    feedback.dataset.state = '';
    return;
  }
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
      const refreshed = await loadGarden();
      throw new Error(result.error === 'garden full'
        ? 'The garden is full. A patch opens when an older plant leaves.'
        : refreshed ? 'That patch is already occupied. Choose another one.' : 'That patch is occupied, and the garden could not refresh. Reload before choosing again.');
    }
    if (!response.ok) throw new Error('Your plant did not take. Try again.');
    const plant = await response.json() as { plant: Plant };
    const display = plantNames[plant.plant.plantType];
    const location = 'patch ' + (plant.plant.x + 1) + ', row ' + (plant.plant.y + 1);
    const refreshed = await loadGarden();
    feedback.textContent = refreshed
      ? 'You planted a ' + display + ' in ' + location + '. It will grow with time.'
      : 'Your ' + display + ' was planted in ' + location + ', but the garden could not refresh. Reload to see it.';
    feedback.dataset.state = refreshed ? '' : 'error';
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
