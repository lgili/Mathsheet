'use strict';
const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { validateDocumentContent } = require('./document-schema');

const VIEW_TYPE = 'mathsheet.sheet';

function sampleDocument() {
  return {
    version: 1,
    layout: 'canvas',
    blocks: [
      { id: crypto.randomUUID(), type: 'text', x: 70, y: 50, text: 'Change a and b. The calculation below updates automatically.' },
      { id: crypto.randomUUID(), type: 'math', x: 70, y: 150, latex: 'a\\coloneq20' },
      { id: crypto.randomUUID(), type: 'math', x: 70, y: 235, latex: 'b\\coloneq4' },
      { id: crypto.randomUUID(), type: 'math', x: 70, y: 320, latex: '\\frac{a+b}{2}=' }
    ]
  };
}

function activate(context) {
  const provider = {
    async resolveCustomTextEditor(document, webviewPanel) {
      const webview = webviewPanel.webview;
      webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media')), vscode.Uri.file(path.join(context.extensionPath, 'engine')), vscode.Uri.file(path.join(context.extensionPath, 'node_modules', 'mathlive'))] };
      const nonce = crypto.randomBytes(16).toString('base64');
      const css = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'worksheet.css')));
      const engine = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'engine', 'core.js')));
      const mathlive = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'node_modules', 'mathlive', 'mathlive.min.js')));
      const fonts = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'node_modules', 'mathlive', 'fonts')));
      const canvasEngine = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'canvas-engine.bundle.js')));
      const canvas = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'canvas.js')));
      const plot = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'plot.js')));
      const ribbon = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'ribbon.js')));
      const app = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'worksheet.js')));
      webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"><title>Mathsheet</title></head><body data-math-fonts="${fonts}/"><main id="app"></main><script nonce="${nonce}" src="${mathlive}"></script><script nonce="${nonce}" src="${engine}"></script><script nonce="${nonce}" src="${canvasEngine}"></script><script nonce="${nonce}" src="${plot}"></script><script nonce="${nonce}" src="${ribbon}"></script><script nonce="${nonce}" src="${canvas}"></script><script nonce="${nonce}" src="${app}"></script></body></html>`;

      let applying = Promise.resolve();
      // Remembers freshly-applied content only to recognize the editor's own echo.
      // The cap keeps it from growing forever if an echo never arrives.
      const pendingContent = new Set();
      const MAX_PENDING = 32;
      const rememberPending = content => {
        pendingContent.add(content);
        if (pendingContent.size > MAX_PENDING) pendingContent.delete(pendingContent.values().next().value);
      };
      const sendDocument = () => webview.postMessage({ type: 'load', content: document.getText() });
      const changeSubscription = vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.uri.toString() !== document.uri.toString()) return;
        const content = document.getText();
        if (pendingContent.has(content)) { pendingContent.delete(content); webview.postMessage({ type: 'savedToBuffer' }); }
        else webview.postMessage({ type: 'load', content });
      });
      const messageSubscription = webview.onDidReceiveMessage(message => {
        if (message.type === 'ready') { sendDocument(); return; }
        if (message.type !== 'update' || typeof message.content !== 'string') return;
        const validation = validateDocumentContent(message.content);
        if (!validation.ok) {
          // Rejecting silently would leave the user unaware of why the edit did not save.
          webview.postMessage({ type: 'saveError', message: 'Change rejected: ' + validation.reason + '.' });
          return;
        }
        rememberPending(message.content);
        applying = applying.then(async () => {
          if (document.isClosed || document.getText() === message.content) { pendingContent.delete(message.content); return; }
          const edit = new vscode.WorkspaceEdit();
          const end = document.positionAt(document.getText().length);
          edit.replace(document.uri, new vscode.Range(new vscode.Position(0, 0), end), message.content);
          const accepted = await vscode.workspace.applyEdit(edit);
          if (!accepted) { pendingContent.delete(message.content); webview.postMessage({ type: 'saveError', message: 'The change was not applied to the document.' }); }
        }).catch(error => { pendingContent.delete(message.content); webview.postMessage({ type: 'saveError', message: String(error) }); });
      });
      webviewPanel.onDidDispose(() => { changeSubscription.dispose(); messageSubscription.dispose(); });
    }
  };
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, { webviewOptions: { retainContextWhenHidden: true } }));
  context.subscriptions.push(vscode.commands.registerCommand('mathsheet.newSheet', async () => {
    const uri = await vscode.window.showSaveDialog({ filters: { Mathsheet: ['mathdoc'] }, saveLabel: 'Create math sheet' });
    if (!uri) return;
    const target = uri.path.endsWith('.mathdoc') ? uri : uri.with({ path: uri.path + '.mathdoc' });
    try {
      await vscode.workspace.fs.stat(target);
      vscode.window.showErrorMessage('That file already exists. Open it to continue.');
      return;
    } catch (error) { if (error.code !== 'FileNotFound') throw error; }
    await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(sampleDocument(), null, 2) + '\n'));
    await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
  }));
}

function deactivate() {}
module.exports = { activate, deactivate };
