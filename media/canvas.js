'use strict';
(function () {
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function createMathField(latex, onInput) {
    const field = new MathLive.MathfieldElement();
    field.className = 'spatial-mathfield';
    field.value = latex || '';
    field.mathVirtualKeyboardPolicy = 'manual';
    field.smartFence = true;
    field.setAttribute('aria-label', 'Editable math expression');
    field.addEventListener('input', () => onInput(field.value));
    return field;
  }
  function render(app, doc, callbacks) {
    if (!globalThis.MathLive || !MathLive.MathfieldElement || !globalThis.MathCanvasEngine || !globalThis.MathPlot) {
      app.replaceChildren(node('p', 'load-error', 'The math editor failed to load. Check the local MathLive installation.'));
      return;
    }
    MathLive.MathfieldElement.fontsDirectory = document.body.dataset.mathFonts;
    app.replaceChildren();
    const header = node('header', 'page-header');
    header.append(node('div', 'eyebrow', 'PROTOTYPE · MATHSHEET'));
    header.append(node('h1', '', 'Mathsheet'));
    header.append(node('p', 'intro', 'Click the sheet to write. Use := to define and a trailing = to evaluate. Pick a unit from the bar; / creates a fraction, ^ an exponent and _ a subscript.'));
    app.append(header);
    const toolbar = node('nav', 'toolbar');
    const textButton = node('button', '', '+ Text');
    textButton.type = 'button';
    textButton.addEventListener('click', () => addBlock('text', 70, nextY()));
    toolbar.append(textButton);
    const mathButton = node('button', '', '+ Equation');
    mathButton.type = 'button';
    mathButton.addEventListener('click', () => addBlock('math', 70, nextY()));
    toolbar.append(mathButton);
    const plotButton = node('button', '', '+ Plot');
    plotButton.type = 'button';
    plotButton.addEventListener('click', () => addBlock('plot', 70, nextY()));
    toolbar.append(plotButton);
    let activeMathField = null;
    let activeBlock = null;
    // One undo step per editing session: typing a long expression must not flood the
    // history, while a drag, a new block or a conversion still produces its own step.
    // render() rebuilds these, so undo and reopen always start a fresh session.
    let editingKey = null;
    function snapshot(key) {
      if (key === editingKey) return;
      editingKey = key;
      callbacks.remember();
    }
    function structuralChange() {
      editingKey = null;
      callbacks.remember();
    }
    const unitLabel = node('label', 'unit-control', 'Insert unit ');
    const unitSelect = node('select', 'unit-select');
    for (const unit of ['', 'm', 'cm', 'km', 's', 'min', 'h', 'kg', 'g', 'm/s', 'km/h']) {
      const option = node('option', '', unit || 'Choose…');
      option.value = unit;
      unitSelect.append(option);
    }
    unitSelect.setAttribute('aria-label', 'Insert a unit into the selected equation');
    unitSelect.disabled = true;
    unitSelect.addEventListener('change', () => {
      if (activeMathField && unitSelect.value) {
        activeMathField.focus();
        activeMathField.insert('\\,\\mathrm{' + unitSelect.value + '}');
      }
      unitSelect.value = '';
    });
    unitLabel.append(unitSelect);
    toolbar.append(unitLabel);
    const convertLabel = node('label', 'unit-control', 'Display in ');
    const convertSelect = node('select', 'unit-select');
    for (const unit of ['', 'm', 'cm', 'km', 's', 'min', 'h', 'kg', 'g', 'm/s', 'km/h']) {
      const option = node('option', '', unit || 'Original unit');
      option.value = unit;
      convertSelect.append(option);
    }
    convertSelect.setAttribute('aria-label', 'Convert the selected equation result');
    convertSelect.disabled = true;
    convertSelect.addEventListener('change', () => {
      if (!activeBlock) return;
      structuralChange();
      activeBlock.convertTo = convertSelect.value || undefined;
      callbacks.changed();
    });
    convertLabel.append(convertSelect);
    toolbar.append(convertLabel);
    const undo = node('button', 'secondary', 'Undo');
    undo.type = 'button';
    // worksheet.js re-enables the button by this id after every recorded change, so
    // typing alone must be able to enable it — not only a drag or a new block.
    undo.id = 'undo-button';
    undo.disabled = !callbacks.canUndo();
    undo.addEventListener('click', callbacks.undo);
    toolbar.append(undo);
    app.append(toolbar);
    const canvas = node('div', 'spatial-canvas');
    canvas.setAttribute('aria-label', 'Spatial math worksheet');
    canvas.addEventListener('focusin', event => {
      activeBlock = doc.blocks.find(item => item.id === event.target.closest('.spatial-block')?.dataset.id);
      activeMathField = activeBlock?.type === 'math' && event.target.matches?.('math-field.spatial-mathfield') ? event.target : null;
      unitSelect.disabled = !activeMathField;
      convertSelect.disabled = !activeMathField;
      convertSelect.value = activeBlock?.convertTo || '';
    });
    canvas.addEventListener('pointerdown', event => {
      if (event.target !== canvas) return;
      const bounds = canvas.getBoundingClientRect();
      addBlock('math', Math.max(0, Math.round(event.clientX - bounds.left)), Math.max(0, Math.round(event.clientY - bounds.top)));
    });
    app.append(canvas);
    for (const block of doc.blocks) renderBlock(block);
    updateResults(doc);
    const footer = node('footer', 'page-footer');
    footer.append(node('span', '', 'The sheet evaluates top to bottom and, at the same height, left to right. Drag the green dot to move.'));
    footer.append(node('span', '', 'Use ⌘/Ctrl+S to save.'));
    app.append(footer);

    function nextY() {
      return Math.max(90, ...doc.blocks.map(block => (Number(block.y) || 0) + (block.type === 'plot' ? 620 : 105)));
    }
    function addBlock(type, x, y) {
      structuralChange();
      const block = type === 'math'
        ? { id: crypto.randomUUID(), type, x, y, latex: '' }
        : type === 'plot'
          ? { id: crypto.randomUUID(), type, x, y, variable: 'x', min: -6.28, max: 6.28, curves: [{ id: crypto.randomUUID(), name: 'Curve 1', latex: '\\sin(x)' }] }
          : { id: crypto.randomUUID(), type, x, y, text: '' };
      doc.blocks.push(block);
      renderBlock(block);
      callbacks.changed();
      const target = canvas.lastElementChild.querySelector(type === 'text' ? 'textarea' : 'math-field');
      if (target) { target.focus(); if (type === 'math') { activeMathField = target; activeBlock = block; convertSelect.disabled = false; unitSelect.disabled = false; convertSelect.value = ''; } }
      undo.disabled = false;
    }
    function renderBlock(block) {
      if (block.type !== 'math' && block.type !== 'text' && block.type !== 'plot') return;
      const wrapper = node('div', 'spatial-block spatial-' + block.type);
      wrapper.style.left = (Number(block.x) || 0) + 'px';
      wrapper.style.top = (Number(block.y) || 0) + 'px';
      wrapper.dataset.id = block.id;
      wrapper.addEventListener('pointerdown', event => event.stopPropagation());
      const handle = node('button', 'drag-handle', '●');
      handle.type = 'button';
      handle.title = 'Drag to move';
      handle.setAttribute('aria-label', 'Move block');
      wrapper.append(handle);
      if (block.type === 'math') {
        wrapper.append(createMathField(block.latex, value => { snapshot(block.id + ':latex'); block.latex = value; callbacks.changed(); }));
        const output = node('output', 'spatial-result');
        output.dataset.resultFor = block.id;
        wrapper.append(output);
      } else if (block.type === 'plot') {
        const panel = node('div', 'plot-panel');
        const settings = node('div', 'plot-settings');
        const variableLabel = node('label', '', 'Variable ');
        const variable = node('input', 'plot-small-input');
        variable.value = block.variable || 'x';
        variable.setAttribute('aria-label', 'Horizontal axis variable');
        variable.addEventListener('input', () => { snapshot(block.id + ':variable'); block.variable = variable.value; callbacks.changed(); });
        variableLabel.append(variable);
        settings.append(variableLabel);
        for (const [key, title] of [['min', 'From'], ['max', 'to']]) {
          const label = node('label', '', title + ' ');
          const input = node('input', 'plot-number-input');
          input.type = 'number'; input.step = 'any'; input.value = block[key];
          input.setAttribute('aria-label', key === 'min' ? 'Horizontal axis minimum' : 'Horizontal axis maximum');
          // Store a number so the saved document keeps the same type the fixtures use.
          // An empty field stays '' and the engine reports the interval as invalid.
          input.addEventListener('input', () => {
            snapshot(block.id + ':' + key);
            block[key] = input.value === '' ? '' : Number(input.value);
            callbacks.changed();
          });
          label.append(input); settings.append(label);
        }
        panel.append(settings);
        const curveList = node('div', 'plot-curves');
        panel.append(curveList);
        function addCurveRow(curve) {
          const row = node('div', 'plot-curve-row');
          const name = node('input', 'plot-name-input');
          name.value = curve.name || '';
          name.placeholder = 'Name';
          name.setAttribute('aria-label', 'Curve name');
          name.addEventListener('input', () => { snapshot(block.id + ':' + curve.id + ':name'); curve.name = name.value; callbacks.changed(); });
          row.append(name);
          const field = createMathField(curve.latex, value => { snapshot(block.id + ':' + curve.id + ':latex'); curve.latex = value; callbacks.changed(); });
          field.setAttribute('aria-label', 'Curve expression');
          row.append(field);
          const removeCurve = node('button', 'plot-curve-remove', '×');
          removeCurve.type = 'button'; removeCurve.title = 'Remove curve';
          removeCurve.addEventListener('click', () => {
            structuralChange();
            block.curves.splice(block.curves.indexOf(curve), 1);
            row.remove(); callbacks.changed(); undo.disabled = false;
          });
          row.append(removeCurve);
          curveList.append(row);
          return field;
        }
        for (const curve of block.curves || []) addCurveRow(curve);
        const addCurve = node('button', 'plot-add-curve', '+ Curve');
        addCurve.type = 'button';
        addCurve.addEventListener('click', () => {
          if (block.curves.length >= 6) return;
          structuralChange();
          const curve = { id: crypto.randomUUID(), name: 'Curve ' + (block.curves.length + 1), latex: '' };
          block.curves.push(curve);
          const field = addCurveRow(curve);
          callbacks.changed(); undo.disabled = false; field.focus();
        });
        panel.append(addCurve);
        const output = node('div', 'plot-output');
        output.dataset.plotFor = block.id;
        panel.append(output);
        wrapper.append(panel);
      } else {
        const area = node('textarea', 'spatial-textarea');
        area.value = block.text || '';
        area.placeholder = 'Write a note…';
        area.setAttribute('aria-label', 'Text note');
        area.addEventListener('input', () => { snapshot(block.id + ':text'); block.text = area.value; callbacks.changed(); });
        wrapper.append(area);
      }
      const remove = node('button', 'spatial-delete', '×');
      remove.type = 'button';
      remove.title = 'Remove block';
      remove.addEventListener('click', () => {
        structuralChange();
        doc.blocks.splice(doc.blocks.indexOf(block), 1);
        wrapper.remove();
        callbacks.changed();
        undo.disabled = false;
      });
      wrapper.append(remove);
      canvas.append(wrapper);
      handle.addEventListener('pointerdown', event => {
        event.preventDefault(); event.stopPropagation();
        structuralChange();
        const startX = event.clientX, startY = event.clientY;
        const oldX = block.x, oldY = block.y;
        handle.setPointerCapture(event.pointerId);
        const move = moveEvent => {
          block.x = Math.max(0, Math.round(oldX + moveEvent.clientX - startX));
          block.y = Math.max(0, Math.round(oldY + moveEvent.clientY - startY));
          wrapper.style.left = block.x + 'px';
          wrapper.style.top = block.y + 'px';
        };
        const end = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', end);
          handle.removeEventListener('pointercancel', end);
          callbacks.changed();
          undo.disabled = false;
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
      });
    }
  }
  function updateResults(doc) {
    const results = MathCanvasEngine.evaluateCanvas(doc);
    document.querySelectorAll('.plot-output').forEach(output => {
      MathPlot.render(output, results[output.dataset.plotFor]);
    });
    document.querySelectorAll('.spatial-result').forEach(output => {
      const result = results[output.dataset.resultFor];
      output.classList.toggle('error', result?.status === 'error');
      const block = doc.blocks.find(item => item.id === output.dataset.resultFor);
      output.replaceChildren();
      if (result?.status === 'ok' && result.kind !== 'definition') {
        if (!String(block?.latex || '').trim().endsWith('=')) output.append(node('span', '', '= '));
        if (result.unit) {
          const formatted = new MathLive.MathfieldElement();
          formatted.value = result.latex;
          formatted.readOnly = true;
          formatted.tabIndex = -1;
          formatted.className = 'spatial-result-math';
          output.append(formatted);
        } else {
          output.append(node('span', '', Number(result.value.toPrecision(12)).toString()));
        }
      } else if (result?.status === 'error') output.textContent = result.message;
      output.title = result?.status === 'error' ? result.message : 'Computed result';
    });
  }
  globalThis.MathCanvas = { render, updateResults };
})();
