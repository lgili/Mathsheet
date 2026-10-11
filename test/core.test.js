'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../engine/core');

const example = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/basic.mathdoc'), 'utf8'));

test('the example document computes the mean and follows input changes', () => {
  assert.equal(core.evaluateDocument(example).at(-1).value, 12);
  example.blocks[1].expression[0].value = '30';
  assert.equal(core.evaluateDocument(example).at(-1).value, 17);
});

test('the visual expression is also the evaluated expression', () => {
  const nodes = [{type:'fraction', numerator:'a+b', denominator:'2'}, {type:'text',value:'+'}, {type:'power',base:'3',exponent:'2'}];
  assert.equal(core.evaluateExpression(core.sourceFromNodes(nodes), {a:20,b:4}), 21);
});

test('respects precedence and exponents', () => {
  assert.equal(core.evaluateExpression('-2^2 + 3*4'), 8);
  assert.equal(core.evaluateExpression('2^3^2'), 512);
});

test('reports local errors and ignores an invalid definition\'s result', () => {
  const document = {version:1,blocks:[
    {id:'1',type:'definition',symbol:'x',expression:[{type:'text',value:'1/0'}]},
    {id:'2',type:'evaluation',expression:[{type:'text',value:'x+1'}]}
  ]};
  const results = core.evaluateDocument(document);
  assert.match(results[0].message, /Division by zero/);
  assert.match(results[1].message, /Undefined symbol: x/);
});

test('forbids redefining symbols and running text as code', () => {
  const document = {version:1,blocks:[
    {id:'1',type:'definition',symbol:'a',expression:[{type:'text',value:'1'}]},
    {id:'2',type:'definition',symbol:'a',expression:[{type:'text',value:'2'}]}
  ]};
  assert.match(core.evaluateDocument(document)[1].message, /already defined/);
  assert.throws(() => core.evaluateExpression('process.exit(1)'), /Undefined symbol|Missing operator|Unrecognized character/);
});
