import { readFileSync, writeFileSync } from 'node:fs';

const [inputPath, outputPath = 'apps/web/public/data/visitors-world.json'] = process.argv.slice(2);
if (!inputPath) throw new Error('Usage: node scripts/build-visitor-map.mjs NATURAL_EARTH_COUNTRIES.geojson [OUTPUT.json]');

const source = JSON.parse(readFileSync(inputPath, 'utf8'));
const countryPaths = new Map();

function distanceToSegment(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (dx === 0 && dy === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point[0] - (start[0] + t * dx), point[1] - (start[1] + t * dy));
}

function simplify(points, tolerance) {
  if (points.length <= 4) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maximum = tolerance;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const distance = distanceToSegment(points[i], points[first], points[last]);
      if (distance > maximum) {
        maximum = distance;
        index = i;
      }
    }
    if (index !== -1) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  const result = points.filter((_point, index) => keep[index]);
  return result.length >= 4 ? result : points;
}

function ringPath(ring) {
  const simplified = simplify(ring, 0.12);
  const coords = simplified.map(([longitude, latitude]) => {
    const x = Math.round(((longitude + 180) / 360) * 1000 * 10) / 10;
    const y = Math.round(((90 - latitude) / 180) * 500 * 10) / 10;
    return x + ',' + y;
  });
  return 'M' + coords.join('L') + 'Z';
}

for (const feature of source.features ?? []) {
  const code = feature.properties?.ISO_A2_EH ?? feature.properties?.ISO_A2;
  if (typeof code !== 'string' || !/^[A-Z]{2}$/.test(code)) continue;
  const geometry = feature.geometry;
  if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) continue;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const paths = countryPaths.get(code) ?? [];
  for (const polygon of polygons) {
    for (const ring of polygon) paths.push(ringPath(ring));
  }
  countryPaths.set(code, paths);
}

const countries = [...countryPaths]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([code, paths]) => ({ code, path: paths.join('') }));
const result = JSON.stringify({ source: 'Natural Earth 1:50m Admin 0 Countries, v5.1.1', countries });
writeFileSync(outputPath, result + '\n');
process.stdout.write('Wrote ' + countries.length + ' country shapes (' + Buffer.byteLength(result) + ' bytes).\n');
