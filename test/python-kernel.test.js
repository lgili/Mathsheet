'use strict';
// Coverage for the Python kernel bridge (engine/python-kernel.js + engine/kernel/runner.py).
// These files are isolated new modules, so this test owns their contract and does not
// touch the math engine or the UI.
//
// The tests skip cleanly when python3 is unavailable, so `npm test` keeps passing on
// machines without a Python interpreter.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { PythonKernel } = require('../engine/python-kernel');

const runnerPath = path.join(__dirname, '..', 'engine', 'kernel', 'runner.py');
const pythonAvailable = (() => {
  try { return spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0; }
  catch { return false; }
})();

let kernel;
test.before(async () => {
  if (!pythonAvailable) return;
  kernel = new PythonKernel({ runnerPath });
  await kernel.start();
});
test.after(async () => {
  if (kernel) await kernel.dispose();
});

test('python block exports numbers and booleans into the sheet bridge', { skip: !pythonAvailable }, async () => {
  const result = await kernel.run({
    code: 'x = a + b\nexport(soma=x, ativo=True)',
    inputs: { a: { type: 'number', value: 20 }, b: { type: 'number', value: 4 } }
  });
  assert.deepEqual(result.outputs, [
    { name: 'soma', value: { type: 'number', value: 24 } },
    { name: 'ativo', value: { type: 'boolean', value: true } }
  ]);
});

test('python state persists across blocks in the same session', { skip: !pythonAvailable }, async () => {
  await kernel.run({
    code: 'v = d / t',
    inputs: { d: { type: 'number', value: 1500 }, t: { type: 'number', value: 120 } }
  });
  const second = await kernel.run({ code: 'export(dobro=v*2)', inputs: {} });
  assert.deepEqual(second.outputs, [{ name: 'dobro', value: { type: 'number', value: 25 } }]);
});

test('captures print output as streams, not on the JSON channel', { skip: !pythonAvailable }, async () => {
  const result = await kernel.run({ code: 'print("oi")', inputs: {} });
  assert.deepEqual(result.streams, [{ name: 'stdout', text: 'oi\n' }]);
  assert.deepEqual(result.displays, []);
});

test('surfaces Python errors with the exception name', { skip: !pythonAvailable }, async () => {
  await assert.rejects(kernel.run({ code: '1/0', inputs: {} }), error => {
    assert.equal(error.ename, 'ZeroDivisionError');
    return true;
  });
});

test('rejects reserved export names instead of leaking them', { skip: !pythonAvailable }, async () => {
  await assert.rejects(kernel.run({ code: 'export(export=1)', inputs: {} }), error => {
    assert.equal(error.ename, 'ValueError');
    return true;
  });
});

test('ping reports a live runner', { skip: !pythonAvailable }, async () => {
  assert.equal(await kernel.ping(), true);
});
