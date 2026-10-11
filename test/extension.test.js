'use strict';
// Covers the path that receives the webview message and writes to the file, which is
// where document validation now acts. The VS Code host is mocked: what matters here is
// the contract between the sheet and the extension, not the editor API.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const state = {
  provider: null,
  changeHandler: null,
  changeDisposed: false,
  messageHandler: null,
  messageDisposed: false,
  disposeHandler: null,
  applied: [],
  applyResult: true
};

const fakeVscode = {
  Uri: { file: value => ({ fsPath: value, path: value, toString: () => 'file://' + value }) },
  Range: class { constructor(start, end) { this.start = start; this.end = end; } },
  Position: class { constructor(line, character) { this.line = line; this.character = character; } },
  WorkspaceEdit: class { replace(...args) { state.applied.push(args); } },
  window: {
    registerCustomEditorProvider: (viewType, provider) => { state.provider = provider; return { dispose() {} }; },
    showSaveDialog: async () => undefined,
    showErrorMessage: () => {}
  },
  workspace: {
    onDidChangeTextDocument: handler => { state.changeHandler = handler; return { dispose: () => { state.changeDisposed = true; } }; },
    applyEdit: async () => state.applyResult,
    fs: {
      stat: async () => { throw Object.assign(new Error('does not exist'), { code: 'FileNotFound' }); },
      writeFile: async () => {}
    }
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    executeCommand: async () => {}
  }
};

const load = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return fakeVscode;
  return load.apply(this, arguments);
};
const extension = require('../src/extension.js');
Module._load = load;

const flush = () => new Promise(resolve => setImmediate(resolve));
const validDocument = JSON.stringify({ version: 1, layout: 'canvas', blocks: [{ id: 'a', type: 'math', x: 0, y: 0, latex: 'a\\coloneq20' }] });

// Wires the extension to a fake editor and returns what the webview received.
async function openEditor(initialContent) {
  const sent = [];
  let content = initialContent;
  const document = {
    uri: { toString: () => 'file:///sheet.mathdoc' },
    getText: () => content,
    positionAt: offset => new fakeVscode.Position(0, offset),
    isClosed: false
  };
  const webview = {
    options: {},
    html: '',
    asWebviewUri: uri => uri,
    cspSource: 'vscode-webview:',
    postMessage: message => sent.push(message),
    onDidReceiveMessage: handler => { state.messageHandler = handler; return { dispose: () => { state.messageDisposed = true; } }; }
  };
  const panel = { webview, onDidDispose: handler => { state.disposeHandler = handler; return { dispose() {} }; } };
  state.applied = [];
  state.applyResult = true;
  await state.provider.resolveCustomTextEditor(document, panel);
  return {
    sent,
    document,
    setContent: value => { content = value; },
    update: async payload => { state.messageHandler(payload); await flush(); await flush(); }
  };
}

test('the extension registers the editor and the ready message sends the document', async () => {
  await extension.activate({ extensionPath: path.join(__dirname, '..'), subscriptions: [] });
  assert.ok(state.provider, 'registered the editor provider');
  const editor = await openEditor('{"version":1,"blocks":[]}');
  await editor.update({ type: 'ready' });
  assert.deepEqual(editor.sent, [{ type: 'load', content: '{"version":1,"blocks":[]}' }]);
});

test('an invalid document does not touch the file and warns the sheet', async () => {
  const editor = await openEditor('{"version":1,"blocks":[]}');
  await editor.update({ type: 'update', content: '{"version":1,"blocks":"not a list"}' });
  assert.equal(state.applied.length, 0, 'no edit was applied');
  assert.equal(editor.sent.length, 1);
  assert.equal(editor.sent[0].type, 'saveError');
  assert.match(editor.sent[0].message, /Change rejected: the document has no block list/);
});

test('broken JSON from the webview is rejected without crashing the extension', async () => {
  const editor = await openEditor('{"version":1,"blocks":[]}');
  await editor.update({ type: 'update', content: 'this is not json' });
  assert.equal(state.applied.length, 0);
  assert.match(editor.sent[0].message, /not valid JSON/);
});

test('a valid document is written to the buffer and the editor echo confirms it', async () => {
  const editor = await openEditor('{"version":1,"blocks":[]}');
  await editor.update({ type: 'update', content: validDocument });
  assert.equal(state.applied.length, 1, 'the edit was applied');
  assert.equal(state.applied[0][2], validDocument);
  assert.equal(editor.sent.filter(message => message.type === 'saveError').length, 0);

  // VS Code notifies the extension after applying: it is the echo of the content we sent.
  editor.setContent(validDocument);
  state.changeHandler({ document: editor.document });
  assert.deepEqual(editor.sent.at(-1), { type: 'savedToBuffer' });
});

test('a change made outside the sheet arrives as a new document', async () => {
  const editor = await openEditor('{"version":1,"blocks":[]}');
  editor.setContent('{"version":1,"blocks":[],"layout":"canvas"}');
  state.changeHandler({ document: editor.document });
  assert.equal(editor.sent.at(-1).type, 'load');
  assert.equal(editor.sent.at(-1).content, '{"version":1,"blocks":[],"layout":"canvas"}');
});

test('the extension does not apply an edit VS Code rejected', async () => {
  const editor = await openEditor('{"version":1,"blocks":[]}');
  state.applyResult = false;
  await editor.update({ type: 'update', content: validDocument });
  assert.deepEqual(editor.sent.at(-1), { type: 'saveError', message: 'The change was not applied to the document.' });
});

test('closing the panel disposes the editor listeners', async () => {
  const editor = await openEditor('{"version":1,"blocks":[]}');
  state.changeDisposed = false;
  state.messageDisposed = false;
  state.disposeHandler();
  assert.equal(state.changeDisposed, true, 'document change listener disposed');
  assert.equal(state.messageDisposed, true, 'message listener disposed');
});
