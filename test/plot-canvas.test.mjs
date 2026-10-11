import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateCanvas } from '../engine/canvas-core.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/plot-canvas.mathdoc', import.meta.url), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));

test('three curves use the earlier definitions and have reproducible points', () => {
  const result = evaluateCanvas(fixture);
  assert.equal(result.waves.status, 'ok');
  assert.equal(result.waves.series.length, 3);
  assert.equal(result.waves.series[0].points.length, 121);
  const midpoint = result.waves.series.map(series => series.points[75].y);
  assert.ok(midpoint[0] > 0.99 && midpoint[0] < 1.01);
  assert.ok(midpoint[1] > 1.99 && midpoint[1] < 2.01);
  assert.ok(midpoint[2] > 2.99 && midpoint[2] < 3.01);
  assert.deepEqual(evaluateCanvas(JSON.parse(JSON.stringify(fixture))).waves.series, result.waves.series);
});

test('changing a definition updates its curve', () => {
  const doc = clone(fixture);
  doc.blocks.find(block => block.id === 'b').latex = 'b\\coloneq4';
  const result = evaluateCanvas(doc);
  assert.ok(result.waves.series[1].points[75].y > 3.99);
  assert.ok(result.waves.series[0].points[75].y < 1.01);
});

test('the plot reports a missing dependency and an invalid range', () => {
  const doc = clone(fixture);
  doc.blocks.find(block => block.id === 'b').y = 900;
  assert.match(evaluateCanvas(doc).waves.message, /Define first: b/);
  doc.blocks.find(block => block.id === 'b').y = 215;
  doc.blocks.find(block => block.id === 'waves').min = 7;
  assert.match(evaluateCanvas(doc).waves.message, /minimum < maximum/);
});

test('the axis variable does not leak into later calculations', () => {
  const doc = clone(fixture);
  doc.blocks.push({ id: 'after', type: 'math', x: 70, y: 1000, latex: 'x=' });
  const result = evaluateCanvas(doc);
  assert.equal(result.waves.status, 'ok');
  assert.match(result.after.message, /Define first: x/);
});

test('an invalid definition removes the dependent curve', () => {
  const doc = clone(fixture);
  doc.blocks.find(block => block.id === 'b').latex = 'b\\coloneq\\frac{1}{0}';
  const result = evaluateCanvas(doc);
  assert.equal(result.b.status, 'error');
  assert.equal(result.waves.status, 'error');
  assert.match(result.waves.message, /Define first: b/);
});

test('a singularity creates a break in the curve', () => {
  const doc = clone(fixture);
  const graph = doc.blocks.find(block => block.id === 'waves');
  graph.curves = [{ id: 'singular', name: '1/x', latex: '\\frac{1}{x}' }];
  const result = evaluateCanvas(doc);
  assert.equal(result.waves.status, 'ok');
  assert.equal(result.waves.series[0].points[60].y, null);
  assert.ok(result.waves.series[0].points[59].y < 0);
  assert.ok(result.waves.series[0].points[61].y > 0);
});
