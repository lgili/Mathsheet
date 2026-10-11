import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateCanvas } from '../engine/canvas-core.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/calculated-canvas.mathdoc', import.meta.url), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));

test('the spatial sheet defines values and evaluates its fraction', () => {
  const result = evaluateCanvas(fixture);
  assert.equal(result.a.value, 20);
  assert.equal(result.b.value, 4);
  assert.equal(result.average.value, 12);
  const changed = clone(fixture);
  changed.blocks.find(block => block.id === 'a').latex = 'a\\coloneq30';
  assert.equal(evaluateCanvas(changed).average.value, 17);
});

test('position on the sheet defines the evaluation order', () => {
  const changed = clone(fixture);
  changed.blocks.find(block => block.id === 'average').y = 100;
  const result = evaluateCanvas(changed);
  assert.match(result.average.message, /Define first/);
  assert.equal(result.a.value, 20);
});

test('an invalid definition leaves no stale value in the next calculation', () => {
  const changed = clone(fixture);
  changed.blocks.find(block => block.id === 'a').latex = 'a\\coloneq\\frac{1}{0}';
  const result = evaluateCanvas(changed);
  assert.equal(result.a.status, 'error');
  assert.match(result.average.message, /Define first: a/);
});

test('distinguishes definition, equality and a trailing-= query', () => {
  const changed = clone(fixture);
  changed.blocks.find(block => block.id === 'average').latex = 'a+b=24';
  assert.match(evaluateCanvas(changed).average.message, /Use :=/);
  changed.blocks.find(block => block.id === 'average').latex = 'a+b=';
  assert.equal(evaluateCanvas(changed).average.value, 24);
});

test('surfaces missing-variable and complex-value errors', () => {
  const changed = clone(fixture);
  changed.blocks.find(block => block.id === 'average').latex = 'x^2';
  assert.match(evaluateCanvas(changed).average.message, /Define first: x/);
  changed.blocks.find(block => block.id === 'average').latex = '\\sqrt{-1}';
  assert.match(evaluateCanvas(changed).average.message, /Result not computed/);
});
