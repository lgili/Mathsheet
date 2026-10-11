#!/usr/bin/env node
// Canonical source for the demo documents in examples/.
//
// Editing an example by hand during a product test is expected — that is how empty
// blocks and test definitions ended up in the examples. This script restores the three
// examples to the state the README describes with `npm run examples:reset`.
//
// The fixtures in test/fixtures/ are frozen contracts for the test suite and are not
// generated here: an example edited during a test must not fail `npm test`.
//
// The script also checks, through the engine, the numbers the README promises, so the
// README's claims about the examples are executable.
import { readFileSync, writeFileSync } from 'node:fs';
import { evaluateCanvas } from '../engine/canvas-core.mjs';

const root = new URL('..', import.meta.url);
const target = name => new URL('examples/' + name, root);

const canvas = blocks => ({ version: 1, layout: 'canvas', blocks });

const examples = {
  'calculated-canvas.mathdoc': canvas([
    { id: 'guide', type: 'text', x: 70, y: 50, text: 'Change a or b. The last expression uses the definitions above and recalculates automatically.' },
    { id: 'a', type: 'math', x: 70, y: 150, latex: 'a\\coloneq20' },
    { id: 'b', type: 'math', x: 70, y: 235, latex: 'b\\coloneq4' },
    { id: 'average', type: 'math', x: 70, y: 320, latex: '\\frac{a+b}{2}=' }
  ]),

  'plot-canvas.mathdoc': canvas([
    { id: 'intro', type: 'text', x: 70, y: 40, text: 'Compare three amplitudes of the same function. Change a, b or c; the three curves below recalculate.' },
    { id: 'a', type: 'math', x: 70, y: 140, latex: 'a\\coloneq1' },
    { id: 'b', type: 'math', x: 70, y: 215, latex: 'b\\coloneq2' },
    { id: 'c', type: 'math', x: 70, y: 290, latex: 'c\\coloneq3' },
    { id: 'waves', type: 'plot', x: 55, y: 390, variable: 'x', min: -6.28, max: 6.28, curves: [
      { id: 'first', name: 'a', latex: 'a\\sin(x)' },
      { id: 'second', name: 'b', latex: 'b\\sin(x)' },
      { id: 'third', name: 'c', latex: 'c\\sin(x)' }
    ] }
  ]),

  'units-canvas.mathdoc': canvas([
    { id: 'intro', type: 'text', x: 70, y: 45, text: 'Define a distance and a time. The speed and the conversions below recalculate automatically.' },
    { id: 'distance', type: 'math', x: 70, y: 130, latex: 'd\\coloneq1500\\,\\mathrm{m}' },
    { id: 'time', type: 'math', x: 70, y: 220, latex: 't\\coloneq120\\,\\mathrm{s}' },
    { id: 'speed', type: 'math', x: 70, y: 310, latex: '\\frac{d}{t}=' },
    { id: 'speed_kmh', type: 'math', x: 70, y: 400, latex: '\\frac{d}{t}=', convertTo: 'km/h' },
    { id: 'distance_km', type: 'math', x: 70, y: 490, latex: 'd=', convertTo: 'km' },
    { id: 'invalid_note', type: 'text', x: 70, y: 570, text: 'Error example: you cannot add length and time.' },
    { id: 'invalid', type: 'math', x: 70, y: 635, latex: 'd+t=' }
  ])
};

const clone = value => JSON.parse(JSON.stringify(value));
const find = (document, id) => document.blocks.find(block => block.id === id);
const close = (value, expected) => typeof value === 'number' && Math.abs(value - expected) < 1e-9;
// Sampled curve values: the tolerance is about sampling, not exact arithmetic.
const near = (value, expected) => typeof value === 'number' && Math.abs(value - expected) < 1e-3;
// The 121 samples run from -6.28 to 6.28; index 75 lands on 1.57, near sin's peak.
const peak = (result, series, index = 75) => result.waves.series[series].points[index].y;

// Each check corresponds to a README claim about the example.
const checks = [
  ['calculated-canvas.mathdoc', 'a:=20, b:=4 and mean 12', document => {
    const result = evaluateCanvas(document);
    return close(result.a.value, 20) && close(result.b.value, 4) && close(result.average.value, 12);
  }],
  ['calculated-canvas.mathdoc', 'a:=30 moves the mean to 17', document => {
    const changed = clone(document);
    find(changed, 'a').latex = 'a\\coloneq30';
    return close(evaluateCanvas(changed).average.value, 17);
  }],
  ['plot-canvas.mathdoc', 'three curves with peaks 1, 2 and 3', document => {
    const result = evaluateCanvas(document);
    return result.waves.series.length === 3 && near(peak(result, 0), 1) && near(peak(result, 1), 2) && near(peak(result, 2), 3);
  }],
  ['plot-canvas.mathdoc', 'b:=4 doubles only the second curve', document => {
    const changed = clone(document);
    find(changed, 'b').latex = 'b\\coloneq4';
    const result = evaluateCanvas(changed);
    return near(peak(result, 0), 1) && near(peak(result, 1), 4) && near(peak(result, 2), 3);
  }],
  ['units-canvas.mathdoc', 'speed 12.5 m/s', document => {
    const result = evaluateCanvas(document);
    return close(result.speed.value, 12.5) && JSON.stringify(result.speed.unit) === JSON.stringify(['Divide', 'm', 's']);
  }],
  ['units-canvas.mathdoc', 'conversions to 45 km/h and 1.5 km', document => {
    const result = evaluateCanvas(document);
    return close(result.speed_kmh.value, 45) && close(result.distance_km.value, 1.5);
  }],
  ['units-canvas.mathdoc', 'adding length and time raises a dimensional error', document => {
    const result = evaluateCanvas(document);
    return result.invalid.status === 'error' && /incompatible dimensions/.test(result.invalid.message);
  }]
];

const checkOnly = process.argv.includes('--check');
let failed = 0;

for (const [name, claim, verify] of checks) {
  const document = examples[name];
  let ok = false;
  let detail = '';
  try {
    ok = !!verify(document);
  } catch (error) {
    detail = ' (' + error.message + ')';
  }
  if (!ok) failed++;
  console.log((ok ? 'ok    ' : 'FAIL  ') + name + ' · ' + claim + detail);
}

if (failed) {
  console.log('\n' + failed + ' README claim(s) do not hold; examples were not changed.');
  process.exit(1);
}

let drifted = 0;
for (const [name, document] of Object.entries(examples)) {
  const content = JSON.stringify(document, null, 2) + '\n';
  const url = target(name);
  if (checkOnly) {
    let current = null;
    try { current = readFileSync(url, 'utf8'); } catch {}
    if (current !== content) { drifted++; console.log('differs    examples/' + name); }
    continue;
  }
  writeFileSync(url, content);
  console.log('written    examples/' + name);
}

if (checkOnly) {
  if (drifted) { console.log('\n' + drifted + ' example(s) out of the canonical state. Run: npm run examples:reset'); process.exit(1); }
  console.log('\nexamples match the canonical state.');
} else {
  console.log('\nREADME checks ok · examples restored.');
}
