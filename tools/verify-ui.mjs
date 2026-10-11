#!/usr/bin/env node
// Verifies the worksheet interface in a real browser.
//
// Loads the same files the webview loads (MathLive, the engine bundle, media/plot.js,
// media/canvas.js and media/worksheet.js), with a mocked VS Code API, and drives the
// interactions the way a person would. That is how the Undo button stayed disabled when
// the first change was typing: the logic was right, the button was never re-enabled.
//
// Uses the frozen fixtures, not the examples: editing an example during a product test
// must not fail this check.
//
// No new dependencies: it uses the browser already installed. `npm run verify:ui`.
// Options: --keep keeps the temporary folder for inspection.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const keep = process.argv.includes('--keep');
const readDoc = file => JSON.parse(readFileSync(join(ROOT, file), 'utf8'));

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium'
  ].filter(Boolean);
  for (const name of ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) {
    try {
      const found = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (found) candidates.push(found);
    } catch { /* not in PATH */ }
  }
  return candidates.find(candidate => {
    try { return statSync(candidate).isFile(); } catch { return false; }
  });
}

const browser = findBrowser();
if (!browser) {
  console.log('verify:ui — no browser found (set CHROME_PATH to point at one). Check skipped.');
  process.exit(0);
}

const calculated = readDoc('test/fixtures/calculated-canvas.mathdoc');
const withMarker = (document, marker) => ({
  ...JSON.parse(JSON.stringify(document)),
  blocks: [{ id: 'marker-' + marker, type: 'text', x: 10, y: 10, text: marker }, ...document.blocks]
});

// worksheet.js ignores a load equal to the last one it sent, so each scenario gets its
// own document.
const documents = {
  calc: calculated,
  drag: withMarker(calculated, 'drag'),
  plot: readDoc('test/fixtures/plot-canvas.mathdoc'),
  units: readDoc('test/fixtures/units-canvas.mathdoc')
};

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>verify:ui</title></head>
<body data-math-fonts="file://${ROOT}/node_modules/mathlive/fonts/">
<main id="app"></main>
<script type="application/json" id="results">[]</script>
<script>
window.__messages = [];
window.acquireVsCodeApi = () => ({ postMessage: message => window.__messages.push(message) });
window.__documents = ${JSON.stringify(documents)};
</script>
<script src="file://${ROOT}/node_modules/mathlive/mathlive.min.js"></script>
<script src="file://${ROOT}/media/canvas-engine.bundle.js"></script>
<script src="file://${ROOT}/media/plot.js"></script>
<script src="file://${ROOT}/media/canvas.js"></script>
<script src="file://${ROOT}/media/worksheet.js"></script>
<script>
(async () => {
  const results = [];
  const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail: String(detail === undefined ? '' : detail) });
  const tick = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms));
  let current = null;
  const load = async key => { current = key; window.__messages = []; window.postMessage({ type: 'load', content: JSON.stringify(window.__documents[key]) }, '*'); await tick(200); };
  const lastDoc = () => { const list = window.__messages.filter(message => message.type === 'update'); return list.length ? JSON.parse(list[list.length - 1].content) : null; };
  const initialBlock = id => window.__documents[current].blocks.find(item => item.id === id);
  // Before the first change there is no update message: the initial state comes from
  // the loaded document.
  const block = id => lastDoc()?.blocks.find(item => item.id === id) ?? initialBlock(id);
  const undoButton = () => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Undo');
  const mathFields = () => [...document.querySelectorAll('math-field.spatial-mathfield')];
  const resultText = id => document.querySelector('[data-result-for="' + id + '"]')?.textContent ?? '';
  const typeInto = async (field, latex) => { field.value = latex; field.dispatchEvent(new Event('input', { bubbles: true })); await tick(200); };

  try {
    // 1. Undo after typing
    await load('calc');
    const startsDisabled = undoButton()?.disabled === true;
    const before = resultText('average');
    await typeInto(mathFields()[0], 'a\\\\coloneq30');
    const typed = resultText('average');
    const enabledByTyping = undoButton()?.disabled === false;
    undoButton().click();
    await tick(250);
    const undone = resultText('average');
    check('typing recalculates the mean (12 -> 17)', typed.includes('17'), 'before=' + before + ' after=' + typed);
    check('typing enables Undo', startsDisabled && enabledByTyping, 'initially disabled=' + startsDisabled + ' enabled after typing=' + enabledByTyping);
    check('Undo restores the previous value (17 -> 12)', undone.includes('12') && !undone.includes('17'), 'after undo=' + undone);
    check('Undo also restores the document', block('a')?.latex === 'a\\\\coloneq20', 'latex=' + block('a')?.latex);

    // 2. Drag and then type
    await load('drag');
    Element.prototype.setPointerCapture = function () {};
    Element.prototype.releasePointerCapture = function () {};
    const handle = document.querySelector('.spatial-block[data-id="a"] .drag-handle');
    const origin = block('a');
    const box = handle.getBoundingClientRect();
    const pointer = (type, x, y) => handle.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, bubbles: true }));
    pointer('pointerdown', box.left + 4, box.top + 4);
    pointer('pointermove', box.left + 64, box.top + 44);
    pointer('pointerup', box.left + 64, box.top + 44);
    await tick(200);
    const moved = block('a');
    check('drag moves the block', moved && (moved.x !== origin.x || moved.y !== origin.y), JSON.stringify({ from: [origin.x, origin.y], to: [moved.x, moved.y] }));
    await typeInto(mathFields()[0], 'a\\\\coloneq7');
    undoButton().click();
    await tick(250);
    const afterFirst = block('a');
    check('first Undo reverts the typing, not the drag', afterFirst?.latex === 'a\\\\coloneq20' && afterFirst?.y === moved.y, JSON.stringify({ latex: afterFirst?.latex, y: afterFirst?.y, draggedTo: moved.y }));
    undoButton().click();
    await tick(250);
    check('second Undo reverts the drag', block('a')?.y === origin.y, 'y=' + block('a')?.y + ' expected=' + origin.y);

    // 3. Plot
    await load('plot');
    check('draws one curve per series', document.querySelectorAll('.plot-output svg path').length === 3, 'curves=' + document.querySelectorAll('.plot-output svg path').length);
    check('legend lists the three curves', document.querySelectorAll('.plot-legend span').length === 3, 'items=' + document.querySelectorAll('.plot-legend span').length);
    const maxInput = document.querySelectorAll('.plot-number-input')[1];
    maxInput.value = '9';
    maxInput.dispatchEvent(new Event('input', { bubbles: true }));
    await tick(200);
    check('interval is stored as a number', typeof block('waves')?.max === 'number' && block('waves').max === 9, 'max=' + JSON.stringify(block('waves')?.max) + ' type=' + typeof block('waves')?.max);
    await typeInto(mathFields()[3], 'a\\\\sin(x)+2\\\\,\\\\mathrm{zzz}');
    const plotError = document.querySelector('.plot-error')?.textContent ?? '';
    check('a misspelled unit in a curve shows on the plot', plotError.includes('Unknown unit'), 'text=' + plotError);

    // 4. Units
    await load('units');
    check('a result with a unit appears formatted', !!document.querySelector('[data-result-for="speed"] math-field.spatial-result-math'), 'text=' + resultText('speed'));
    const dimensional = document.querySelector('[data-result-for="invalid"]')?.textContent ?? '';
    check('incompatible sum shows a dimensional error', dimensional.includes('incompatible dimensions'), 'text=' + dimensional);
    await typeInto(mathFields()[0], 'd\\\\coloneq2\\\\,\\\\mathrm{foobar}');
    const misspelled = document.querySelector('[data-result-for="distance"]')?.textContent ?? '';
    check('a misspelled unit shows the diagnostic on the sheet', misspelled.includes('Unknown unit'), 'text=' + misspelled);
  } catch (error) {
    results.push({ name: 'verification run', pass: false, detail: 'exception: ' + (error && error.stack ? error.stack.split('\\n').slice(0, 3).join(' | ') : error) });
  }

  document.getElementById('results').textContent = JSON.stringify(results);
})();
</script>
</body></html>`;

const workdir = mkdtempSync(join(tmpdir(), 'math-verify-ui-'));
let results = [];
try {
  writeFileSync(join(workdir, 'page.html'), page);
  const browserArgs = extra => [
    '--headless=new', '--disable-gpu', '--no-first-run', '--allow-file-access-from-files',
    ...extra,
    '--user-data-dir=' + join(workdir, 'profile'), '--virtual-time-budget=30000', '--dump-dom',
    'file://' + join(workdir, 'page.html')
  ];
  const runBrowser = extra => execFileSync(browser, browserArgs(extra), {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
  });
  let dom = '';
  try {
    dom = runBrowser([]);
  } catch (error) {
    // Inside a process sandbox (macOS seatbelt, containers) the browser cannot initialize
    // its own sandbox and dies before loading the page. That is an environment limit, not
    // a defect in the sheet: retry once without the browser sandbox, which only removes
    // isolation from a local headless page built here.
    const detail = String(error.stderr || '') + error.message;
    if (!/sandbox/i.test(detail)) {
      console.log('verify:ui — the browser failed to run the page: ' + error.message);
      process.exit(1);
    }
    try {
      dom = runBrowser(['--no-sandbox']);
      console.log('verify:ui — the browser sandbox could not start here; ran with --no-sandbox.');
    } catch (retry) {
      console.log('verify:ui — the browser failed to run the page even with --no-sandbox: ' + retry.message);
      process.exit(1);
    }
  }
  const match = /<script type="application\/json" id="results">([\s\S]*?)<\/script>/.exec(dom);
  if (!match) { console.log('verify:ui — could not find the results block in the generated DOM'); process.exit(1); }
  results = JSON.parse(match[1]);
  if (!results.length) { console.log('verify:ui — the page script did not finish'); process.exit(1); }
} finally {
  if (keep) console.log('page kept at ' + workdir);
  else rmSync(workdir, { recursive: true, force: true });
}

for (const item of results) console.log((item.pass ? 'ok    ' : 'FAIL  ') + item.name + (item.pass ? '' : ' — ' + item.detail));
const failed = results.filter(item => !item.pass).length;
console.log('\nverify:ui — ' + (results.length - failed) + '/' + results.length + ' checks passed (' + browser + ')');
process.exit(failed ? 1 : 0);
