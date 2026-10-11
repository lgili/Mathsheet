'use strict';
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let doc = null;
  let history = [];
  let redoStack = [];
  let lastSent = null;

  const id = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : 'b' + Date.now() + Math.random().toString(16).slice(2));
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function button(label, title, handler, className) {
    const node = element('button', className || '', label);
    node.type = 'button';
    node.title = title;
    node.addEventListener('click', handler);
    return node;
  }
  function remember() {
    history.push(JSON.stringify(doc));
    if (history.length > 100) history.shift();
    redoStack = [];
    updateUndo();
  }
  function updateUndo() {
    const undo = document.getElementById('undo-button');
    if (undo) undo.disabled = !history.length;
  }
  function changed() {
    if (doc.layout === 'canvas') MathCanvas.updateResults(doc);
    else renderResults();
    const content = JSON.stringify(doc, null, 2) + '\n';
    lastSent = content;
    vscode.postMessage({ type: 'update', content });
    const status = document.getElementById('save-status');
    if (status) status.textContent = 'Change sent to VS Code · use ⌘/Ctrl+S to save';
  }
  function input(value, label, onChange, className, width) {
    const node = element('input', className || 'math-input');
    node.type = 'text';
    node.value = value || '';
    node.setAttribute('aria-label', label);
    node.spellcheck = false;
    if (width) node.style.width = width;
    else node.style.width = Math.max(3, (value || '').length + 1) + 'ch';
    node.addEventListener('focus', () => { node.dataset.before = JSON.stringify(doc); });
    node.addEventListener('input', () => {
      const previous = JSON.stringify(doc);
      onChange(node.value);
      if (JSON.stringify(doc) !== previous) {
        history.push(previous);
        if (history.length > 100) history.shift();
        updateUndo();
        changed();
      }
      if (!width) node.style.width = Math.max(3, node.value.length + 1) + 'ch';
    });
    return node;
  }
  function expressionEditor(block) {
    const row = element('div', 'expression-editor');
    const nodes = block.expression;
    nodes.forEach((part, index) => {
      if (part.type === 'text') {
        row.append(input(part.value, 'Expression, use * to multiply', value => { part.value = value; }, 'math-input'));
      } else if (part.type === 'fraction') {
        const fraction = element('span', 'fraction');
        fraction.append(input(part.numerator, 'Numerator', value => { part.numerator = value; }, 'math-input fraction-field'));
        fraction.append(element('span', 'fraction-line'));
        fraction.append(input(part.denominator, 'Denominator', value => { part.denominator = value; }, 'math-input fraction-field'));
        row.append(fraction);
      } else if (part.type === 'power') {
        const power = element('span', 'power');
        power.append(input(part.base, 'Power base', value => { part.base = value; }, 'math-input'));
        const exponent = element('sup');
        exponent.append(input(part.exponent, 'Exponent', value => { part.exponent = value; }, 'math-input exponent-field'));
        power.append(exponent);
        row.append(power);
      }
      if (part.type !== 'text' || nodes.length > 1) row.append(button('×', 'Remove this element', () => {
        remember();
        nodes.splice(index, 1);
        if (!nodes.length) nodes.push({ type: 'text', value: '' });
        render(); changed();
      }, 'remove-node'));
    });
    return row;
  }
  function blockEditor(block, index) {
    const card = element('section', 'block');
    card.dataset.id = block.id;
    const controls = element('div', 'block-controls');
    controls.append(element('span', 'block-kind', block.type === 'text' ? 'TEXT' : block.type === 'definition' ? 'DEFINITION' : 'CALCULATION'));
    controls.append(button('↑', 'Move block up', () => move(index, -1), 'small-button'));
    controls.append(button('↓', 'Move block down', () => move(index, 1), 'small-button'));
    controls.append(button('Delete', 'Delete block', () => { remember(); doc.blocks.splice(index, 1); render(); changed(); }, 'small-button'));
    card.append(controls);
    if (block.type === 'text') {
      const area = element('textarea', 'text-editor');
      area.value = block.text || '';
      area.placeholder = 'Explain the reasoning here…';
      area.setAttribute('aria-label', 'Document text');
      area.addEventListener('input', () => { const before = JSON.stringify(doc); block.text = area.value; history.push(before); if (history.length > 100) history.shift(); updateUndo(); changed(); });
      card.append(area);
      return card;
    }
    const equation = element('div', 'equation');
    if (block.type === 'definition') {
      equation.append(input(block.symbol, 'Variable name', value => { block.symbol = value; }, 'math-input symbol-field', '6ch'));
      equation.append(element('span', 'relation', ':='));
    }
    equation.append(expressionEditor(block));
    equation.append(element('span', 'relation', '='));
    equation.append(element('output', 'result', '…'));
    card.append(equation);
    const tools = element('div', 'expression-tools');
    tools.append(button('+ Text', 'Add a piece to the expression', () => addNode(block, { type: 'text', value: '' })));
    tools.append(button('+ Fraction', 'Insert a fraction with editable numerator and denominator', () => addNode(block, { type: 'fraction', numerator: '', denominator: '' })));
    tools.append(button('+ Power', 'Insert a power with editable base and exponent', () => addNode(block, { type: 'power', base: '', exponent: '' })));
    card.append(tools);
    return card;
  }
  function addNode(block, node) {
    remember();
    if (block.expression.length === 1 && block.expression[0].type === 'text' && !block.expression[0].value) block.expression = [node];
    else block.expression.push(node);
    render(); changed();
    const card = Array.from(document.querySelectorAll('.block')).find(card => card.dataset.id === block.id);
    if (card) { const fields = card.querySelectorAll('.expression-editor input'); if (fields.length) fields[fields.length - (node.type === 'text' ? 1 : 2)].focus(); }
  }
  function move(index, offset) {
    const other = index + offset;
    if (other < 0 || other >= doc.blocks.length) return;
    remember();
    [doc.blocks[index], doc.blocks[other]] = [doc.blocks[other], doc.blocks[index]];
    render(); changed();
  }
  function addBlock(type) {
    remember();
    doc.blocks.push(type === 'text' ? { id: id(), type, text: '' } : { id: id(), type, ...(type === 'definition' ? { symbol: '' } : {}), expression: [{ type: 'text', value: '' }] });
    render(); changed();
    const card = document.querySelector('.block:last-child');
    if (card) (card.querySelector('.text-editor, .symbol-field, .expression-editor input') || card).focus();
  }
  function renderResults() {
    if (!doc) return;
    const results = MathCore.evaluateDocument(doc);
    for (const result of results) {
      const card = Array.from(document.querySelectorAll('.block')).find(node => node.dataset.id === result.id);
      if (!card) continue;
      const output = card.querySelector('output');
      if (!output) continue;
      output.classList.toggle('error', result.status === 'error');
      output.textContent = result.status === 'ok' ? Number(result.value.toPrecision(12)).toString() : result.message;
      output.title = result.status === 'error' ? result.message : 'Computed result';
    }
  }
  function undoChange() {
    if (!history.length) return;
    redoStack.push(JSON.stringify(doc));
    doc = JSON.parse(history.pop());
    render(); changed();
  }
  function redoChange() {
    if (!redoStack.length) return;
    history.push(JSON.stringify(doc));
    doc = JSON.parse(redoStack.pop());
    render(); changed();
  }
  function render() {
    if (doc.layout === 'canvas') {
      MathCanvas.render(app, doc, { changed, remember, canUndo: () => history.length > 0, canRedo: () => redoStack.length > 0, undo: undoChange, redo: redoChange });
      return;
    }
    app.replaceChildren();
    const header = element('header', 'page-header');
    header.append(element('div', 'eyebrow', 'PROTOTYPE · MATHSHEET'));
    header.append(element('h1', '', 'Mathsheet'));
    header.append(element('p', 'intro', 'Write an idea, define values and see the calculations on the same page.'));
    app.append(header);
    const toolbar = element('nav', 'toolbar');
    toolbar.setAttribute('aria-label', 'Document tools');
    toolbar.append(button('+ Text', 'Add a text block', () => addBlock('text')));
    toolbar.append(button('+ Definition', 'Add a variable definition', () => addBlock('definition')));
    toolbar.append(button('+ Calculation', 'Add an expression to evaluate', () => addBlock('evaluation')));
    const undo = button('Undo', 'Undo the last edit on the sheet', undoChange, 'secondary');
    undo.id = 'undo-button';
    toolbar.append(undo);
    app.append(toolbar);
    const page = element('div', 'sheet');
    doc.blocks.forEach((block, index) => page.append(blockEditor(block, index)));
    app.append(page);
    const footer = element('footer', 'page-footer');
    footer.append(element('span', 'help', 'Use * to multiply and a decimal point (e.g. 2.5). Fractions and powers can be inserted from each block\'s buttons.'));
    footer.append(element('span', 'save-status', 'Use ⌘/Ctrl+S to save.'));
    footer.lastChild.id = 'save-status';
    app.append(footer);
    updateUndo(); renderResults();
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'savedToBuffer') { const status = document.getElementById('save-status'); if (status) status.textContent = 'Updated in the editor · use ⌘/Ctrl+S to save'; return; }
    if (message.type === 'saveError') { const status = document.getElementById('save-status'); if (status) status.textContent = message.message; return; }
    if (message.type !== 'load' || typeof message.content !== 'string') return;
    if (message.content === lastSent) return;
    try {
      const incoming = JSON.parse(message.content);
      if (incoming.layout === 'canvas') {
        if (incoming.version !== 1 || !Array.isArray(incoming.blocks)) throw new Error('Invalid spatial worksheet format.');
      } else MathCore.evaluateDocument(incoming);
      doc = incoming;
      history = [];
      redoStack = [];
      lastSent = message.content;
      render();
    } catch (error) {
      app.replaceChildren(element('p', 'load-error', 'Could not open the document: ' + error.message));
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
