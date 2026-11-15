import { ISO_3166_ALPHA2_CODES } from '../../../../../packages/shared/countries.js';

interface CountryShape {
  readonly code: string;
  readonly path: string;
}
interface MapData {
  readonly source: string;
  readonly countries: readonly CountryShape[];
}
interface CountryCount {
  readonly code: string;
  readonly count: number;
}
interface MapState {
  readonly countries: readonly CountryCount[];
  readonly total: number;
  readonly yourCountry: string | null;
}

const svgNamespace = 'http://www.w3.org/2000/svg';
function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error('Missing Visitors Map element: ' + selector);
  return element;
}

const mapGroup = required<SVGGElement>('#country-shapes');
const mapSvg = required<SVGSVGElement>('#world-map');
const countrySelect = required<HTMLSelectElement>('#country-select');
const countryCount = required<HTMLParagraphElement>('#country-count');
const addButton = required<HTMLButtonElement>('#add-country');
const removeButton = required<HTMLButtonElement>('#remove-country');
const feedback = required<HTMLParagraphElement>('#map-feedback');
const caption = required<HTMLElement>('#map-caption');

const countryNames = new Intl.DisplayNames(undefined, { type: 'region' });
let shapes = new Map<string, SVGPathElement>();
let counts = new Map<string, number>();
let state: MapState = { countries: [], total: 0, yourCountry: null };
let selectedCountry = '';
let busy = false;

function nameFor(code: string): string {
  return countryNames.of(code) ?? code;
}

function updateSelectorCounts(): void {
  const selected = countrySelect.value;
  const first = countrySelect.querySelector<HTMLOptionElement>('option[value=""]');
  countrySelect.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose a country…';
  countrySelect.append(placeholder);
  const options = ISO_3166_ALPHA2_CODES
    .map(code => ({ code, name: nameFor(code) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const item of options) {
    const option = document.createElement('option');
    option.value = item.code;
    const number = counts.get(item.code) ?? 0;
    option.textContent = number > 0
      ? item.name + ' · ' + number + (number === 1 ? ' mark' : ' marks')
      : item.name;
    countrySelect.append(option);
  }
  if (selected && ISO_3166_ALPHA2_CODES.includes(selected as typeof ISO_3166_ALPHA2_CODES[number])) {
    countrySelect.value = selected;
  } else if (state.yourCountry) {
    countrySelect.value = state.yourCountry;
  } else if (first?.value) {
    countrySelect.value = first.value;
  }
}

function updateDetail(): void {
  selectedCountry = countrySelect.value;
  for (const [code, path] of shapes) path.classList.toggle('selected', code === selectedCountry);
  if (!selectedCountry) {
    countryCount.textContent = 'Choose a country to see its marks.';
    addButton.disabled = true;
    addButton.textContent = state.yourCountry ? 'Choose a country' : 'Add my country';
    removeButton.hidden = !state.yourCountry;
    return;
  }
  const countryName = nameFor(selectedCountry);
  const number = counts.get(selectedCountry) ?? 0;
  countryCount.textContent = number === 0
    ? 'No marks from ' + countryName + ' yet.'
    : number + (number === 1 ? ' mark from ' : ' marks from ') + countryName + '.';
  const alreadyHere = state.yourCountry === selectedCountry;
  addButton.textContent = state.yourCountry ? 'Move my mark here' : 'Add my country';
  addButton.disabled = busy || alreadyHere;
  removeButton.hidden = !state.yourCountry;
  removeButton.disabled = busy;
}

function paintCounts(): void {
  for (const [code, path] of shapes) {
    const number = counts.get(code) ?? 0;
    path.classList.toggle('has-marks', number > 0);
    path.classList.toggle('level-1', number > 0 && number < 5);
    path.classList.toggle('level-2', number >= 5 && number < 20);
    path.classList.toggle('level-3', number >= 20);
    path.setAttribute('aria-label', nameFor(code) + (number ? ', ' + number + (number === 1 ? ' mark' : ' marks') : ', no marks'));
  }
  updateSelectorCounts();
  updateDetail();
  caption.textContent = state.total === 0
    ? 'No marks yet. Choose a country if you would like to leave one.'
    : 'Shaded countries have one or more marks. These are voluntary choices, not live locations.';
}

function renderState(next: MapState): void {
  state = next;
  counts = new Map(next.countries.map(item => [item.code, item.count]));
  paintCounts();
}

async function loadState(): Promise<void> {
  try {
    const response = await fetch('/api/map/state', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('The map is hard to reach. Try again in a moment.');
    renderState(await response.json() as MapState);
  } catch (error) {
    feedback.textContent = error instanceof Error ? error.message : 'The map is hard to reach.';
    feedback.dataset.state = 'error';
  }
}

async function loadShapes(): Promise<void> {
  try {
    const response = await fetch('/data/visitors-world.json', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Map boundaries could not be loaded.');
    const data = await response.json() as MapData;
    const fragment = document.createDocumentFragment();
    for (const feature of data.countries) {
      if (!ISO_3166_ALPHA2_CODES.includes(feature.code as typeof ISO_3166_ALPHA2_CODES[number])) continue;
      const path = document.createElementNS(svgNamespace, 'path');
      path.classList.add('map-country');
      path.dataset.country = feature.code;
      path.setAttribute('d', feature.path);
      path.setAttribute('fill-rule', 'evenodd');
      path.setAttribute('aria-hidden', 'true');
      fragment.append(path);
      shapes.set(feature.code, path);
    }
    mapGroup.replaceChildren(fragment);
    paintCounts();
  } catch (error) {
    feedback.textContent = error instanceof Error ? error.message : 'Map boundaries could not be loaded.';
    feedback.dataset.state = 'error';
  }
}

function selectCountry(code: string): void {
  if (!ISO_3166_ALPHA2_CODES.includes(code as typeof ISO_3166_ALPHA2_CODES[number])) return;
  countrySelect.value = code;
  feedback.textContent = '';
  feedback.dataset.state = '';
  updateDetail();
}

countrySelect.addEventListener('change', () => {
  feedback.textContent = '';
  feedback.dataset.state = '';
  updateDetail();
});
mapSvg.addEventListener('click', event => {
  const target = event.target instanceof Element ? event.target.closest<SVGPathElement>('[data-country]') : null;
  const code = target?.dataset.country;
  if (code) selectCountry(code);
});

async function saveCountry(countryCode: string | null): Promise<void> {
  if (busy) return;
  busy = true;
  addButton.disabled = true;
  removeButton.disabled = true;
  feedback.textContent = countryCode === null ? 'Removing your mark…' : 'Saving your choice…';
  feedback.dataset.state = '';
  try {
    const response = await fetch('/api/map/contribution', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ countryCode }),
    });
    if (response.status === 409) {
      const result = await response.json() as { error?: string };
      throw new Error(result.error === 'map at capacity'
        ? 'The map is full for now.'
        : 'There is no mark to remove from this browser.');
    }
    if (response.status === 429) throw new Error('Please wait a little before changing your mark again.');
    if (!response.ok) throw new Error('Your choice could not be saved.');
    await loadState();
    feedback.textContent = countryCode === null
      ? 'Your mark has been removed.'
      : 'Your mark for ' + nameFor(countryCode) + ' is on the map.';
    feedback.dataset.state = '';
  } catch (error) {
    feedback.textContent = error instanceof Error ? error.message : 'Your choice could not be saved.';
    feedback.dataset.state = 'error';
  } finally {
    busy = false;
    updateDetail();
  }
}

addButton.addEventListener('click', () => {
  if (countrySelect.value) void saveCountry(countrySelect.value);
});
removeButton.addEventListener('click', () => void saveCountry(null));
void Promise.all([loadState(), loadShapes()]);
