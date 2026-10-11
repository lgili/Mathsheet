import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateCanvas } from '../engine/canvas-core.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/units-canvas.mathdoc', import.meta.url), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));

test('computes quantities and converts speed and length', () => {
  const result = evaluateCanvas(fixture);
  assert.equal(result.distance.value, 1500);
  assert.equal(result.distance.unit, 'm');
  assert.equal(result.speed.value, 12.5);
  assert.deepEqual(result.speed.unit, ['Divide', 'm', 's']);
  assert.equal(result.speed_kmh.value, 45);
  assert.equal(result.distance_km.value, 1.5);
  assert.equal(result.invalid.status, 'error');
  assert.match(result.invalid.message, /incompatible dimensions/);
});

test('changing an input updates the conversions', () => {
  const doc = clone(fixture);
  doc.blocks.find(block => block.id === 'distance').latex = 'd\\coloneq3000\\,\\mathrm{m}';
  const result = evaluateCanvas(doc);
  assert.equal(result.speed.value, 25);
  assert.equal(result.speed_kmh.value, 90);
  assert.equal(result.distance_km.value, 3);
});

test('rejects unknown units and incompatible conversions', () => {
  const doc = clone(fixture);
  doc.blocks.find(block => block.id === 'distance').latex = 'd\\coloneq2\\,\\mathrm{foobar}';
  const misspelled = evaluateCanvas(doc).distance;
  assert.equal(misspelled.status, 'error');
  assert.match(misspelled.message, /Unknown unit: foobar/);
  doc.blocks.find(block => block.id === 'distance').latex = 'd\\coloneq2\\,\\mathrm{m}';
  doc.blocks.find(block => block.id === 'distance_km').convertTo = 's';
  assert.equal(evaluateCanvas(doc).distance_km.status, 'error');
});

test('a conversion to a nonexistent unit is rejected', () => {
  // `convertTo` comes from the file, not from typing: no made-up LaTeX name becomes a
  // unit, so this is the path that validates the conversion target.
  const doc = clone(fixture);
  doc.blocks.find(block => block.id === 'distance_km').convertTo = 'foobar';
  const result = evaluateCanvas(doc).distance_km;
  assert.equal(result.status, 'error');
  assert.match(result.message, /Unknown unit: foobar/);
});

test('a misspelled unit is not confused with a missing variable', () => {
  const doc = { version: 1, layout: 'canvas', blocks: [
    { id: 'a', type: 'math', x: 0, y: 0, latex: '2\\,\\mathrm{foobar}=' },
    { id: 'b', type: 'math', x: 0, y: 10, latex: 'y=' },
    { id: 'p', type: 'plot', x: 0, y: 20, variable: 'x', min: 0, max: 3,
      curves: [{ id: 'c', name: 'C', latex: 'x\\,\\mathrm{zzz}' }] }
  ] };
  const result = evaluateCanvas(doc);
  assert.match(result.a.message, /Unknown unit: foobar/);
  assert.doesNotMatch(result.a.message, /Define first/);
  assert.match(result.b.message, /Define first: y/);
  assert.match(result.p.message, /Unknown unit: zzz/);
});

test('sums compatible quantities after converting scales', () => {
  const doc = { version: 1, layout: 'canvas', blocks: [
    { id: 'sum', type: 'math', x: 0, y: 0, latex: '100\\,\\mathrm{cm}+1\\,\\mathrm{m}=' }
  ] };
  const result = evaluateCanvas(doc);
  assert.equal(result.sum.status, 'ok');
  assert.equal(result.sum.value, 2);
  assert.equal(result.sum.unit, 'm');
});
