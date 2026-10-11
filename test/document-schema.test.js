'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateDocumentContent, MAX_BLOCKS } = require('../src/document-schema');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const doc = (blocks, extra = {}) => JSON.stringify({ version: 1, layout: 'canvas', blocks, ...extra });
const math = (id, latex) => ({ id, type: 'math', x: 0, y: 0, latex });

test('every example and fixture document is accepted', () => {
  const folders = ['examples', 'test/fixtures'];
  const files = folders.flatMap(folder => fs.readdirSync(path.join(root, folder))
    .filter(name => name.endsWith('.mathdoc'))
    .map(name => path.join(folder, name)));
  assert.ok(files.length >= 8, 'expected the examples and fixtures, found ' + files.length);
  for (const file of files) {
    const result = validateDocumentContent(read(file));
    assert.equal(result.ok, true, file + ' was rejected: ' + result.reason);
  }
});

test('accepts both formats and returns the parsed document', () => {
  const result = validateDocumentContent(doc([math('a', 'a\\coloneq20')]));
  assert.equal(result.ok, true);
  assert.equal(result.document.blocks[0].latex, 'a\\coloneq20');
  assert.equal(validateDocumentContent(read('test/fixtures/basic.mathdoc')).ok, true, 'legacy format without layout');
});

test('rejects content that is not an expected document', () => {
  const cases = [
    ['not text', 42, /not text/],
    ['not JSON', 'a:=20', /not valid JSON/],
    ['JSON that is not an object', '[]', /not an object/],
    ['unknown version', JSON.stringify({ version: 2, blocks: [] }), /version/],
    ['unknown layout', JSON.stringify({ version: 1, layout: 'sheet', blocks: [] }), /unknown layout/],
    ['no block list', JSON.stringify({ version: 1 }), /no block list/],
    ['too many blocks', doc(Array.from({ length: MAX_BLOCKS + 1 }, (unused, index) => math('b' + index, '1'))), /exceeds 1000 blocks/]
  ];
  for (const [label, content, expected] of cases) {
    const result = validateDocumentContent(content);
    assert.equal(result.ok, false, label + ' should be rejected');
    assert.match(result.reason, expected, label);
  }
});

test('rejects malformed blocks and duplicate identifiers', () => {
  const cases = [
    ['unknown type on the spatial sheet', [{ id: 'a', type: 'mystery' }], /unknown type/],
    ['block without an identifier', [{ type: 'math', latex: '1' }], /no identifier/],
    ['equation without an expression', [{ id: 'a', type: 'math' }], /math block .* no expression/],
    ['text without text', [{ id: 'a', type: 'text' }], /text block .* no text/],
    ['conversion that is not text', [{ id: 'a', type: 'math', latex: '1', convertTo: 7 }], /invalid conversion/],
    ['plot without curves', [{ id: 'a', type: 'plot', curves: 'x' }], /plot block .* no curves/],
    ['curve without an expression', [{ id: 'a', type: 'plot', curves: [{ name: 'C' }] }], /no expression/],
    ['too many curves', [{ id: 'a', type: 'plot', curves: Array.from({ length: 7 }, () => ({ latex: 'x' })) }], /more than 6 curves/],
    ['invalid interval', [{ id: 'a', type: 'plot', curves: [{ latex: 'x' }], min: 'zero' }], /invalid min/],
    ['duplicate identifier', [math('a', '1'), math('a', '2')], /duplicate identifier/]
  ];
  for (const [label, blocks, expected] of cases) {
    const result = validateDocumentContent(doc(blocks));
    assert.equal(result.ok, false, label + ' should be rejected');
    assert.match(result.reason, expected, label);
  }
});

test('does not mix block types between the two formats', () => {
  assert.equal(validateDocumentContent(doc([{ id: 'a', type: 'definition', symbol: 'a', expression: [] }])).ok, false, 'definition does not exist on the spatial sheet');
  const legacy = JSON.stringify({ version: 1, blocks: [math('a', '1')] });
  assert.equal(validateDocumentContent(legacy).ok, false, 'math block does not exist in the legacy format');
});

test('accepts an interval as a number and as text', () => {
  const numeric = doc([{ id: 'a', type: 'plot', variable: 'x', min: -6.28, max: 6.28, curves: [{ id: 'c', name: 'C', latex: '\\sin(x)' }] }]);
  const textual = doc([{ id: 'a', type: 'plot', variable: 'x', min: '-6.28', max: '6.28', curves: [{ id: 'c', name: 'C', latex: '\\sin(x)' }] }]);
  assert.equal(validateDocumentContent(numeric).ok, true);
  assert.equal(validateDocumentContent(textual).ok, true);
});
