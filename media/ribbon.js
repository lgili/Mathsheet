'use strict';
/**
 * Command ribbon — declarative action registry + selection context.
 *
 * Loaded BEFORE canvas.js (it exposes globalThis.MathRibbon). The action gallery is
 * DATA, not code: canvas.js builds the ribbon from `MathRibbon.registry` and feeds
 * `MathRibbon.SelectionContext` with the current selection.
 *
 * An action may declare:
 *   - `size`: 'large' (icon above the label) or 'small' (icon beside the label).
 *   - `icon`: key into `MathRibbon.icons` (inline SVG paths, 24×24, stroke-based).
 *   - `when(ctx)`: enables/disables the button for the current selection.
 *   - `run(ctx)`: what the button does.
 */
(function () {
  /**
   * Current sheet selection/context. canvas.js owns the instance and fills the fields;
   * ribbon actions only know this object.
   */
  class SelectionContext {
    constructor() {
      this.activeBlock = null;      // active document block (or null)
      this.activeMathField = null;  // focused MathfieldElement (or null)
      this.delegate = null;         // concrete operations supplied by canvas.js
    }

    setSelection({ block = null, mathField = null } = {}) {
      this.activeBlock = block;
      this.activeMathField = mathField;
    }

    // Predicates used in `when(action)` to enable/disable buttons.
    get mathFieldFocused() { return this.activeMathField !== null; }
    get blockType() { return this.activeBlock ? this.activeBlock.type : null; }
    get pythonBlockActive() { return this.blockType === 'python'; }
    get plotBlockActive() { return this.blockType === 'plot'; }
    get canUndo() { return this.delegate?.canUndo?.() ?? false; }
    get canRedo() { return this.delegate?.canRedo?.() ?? false; }

    // Operations the ribbon delegates to canvas.js (no-op when the delegate is absent).
    insert(latex) { this.delegate?.insert?.(latex); }
    addBlock(type) { this.delegate?.addBlock?.(type); }
    runCurrentBlock() { this.delegate?.runCurrentBlock?.(); }
    interrupt() { this.delegate?.interrupt?.(); }
    undo() { this.delegate?.undo?.(); }
    redo() { this.delegate?.redo?.(); }
    addCurve() { this.delegate?.addCurve?.(); }
    removeCurve() { this.delegate?.removeCurve?.(); }
  }

  class ActionRegistry {
    constructor() { this.actions = new Map(); }

    register(action) {
      if (!action || typeof action !== 'object') throw new Error('Invalid action.');
      if (!action.id || !action.tab || !action.label || typeof action.run !== 'function') {
        throw new Error('Action requires id, tab, label and run: ' + JSON.stringify(action && action.id));
      }
      this.actions.set(action.id, action);
    }

    get(id) { return this.actions.get(id); }
    all() { return [...this.actions.values()]; }
    tabs() { return [...new Set(this.all().map(action => action.tab))]; }

    forTab(tab) { return this.all().filter(action => action.tab === tab); }

    /** Groups a tab's actions by `group` (insertion order preserved). */
    groupsForTab(tab) {
      const groups = new Map();
      for (const action of this.forTab(tab)) {
        const key = action.group || '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(action);
      }
      return groups;
    }

    isEnabled(action, ctx) { return !action.when || action.when(ctx); }
  }

  const registry = new ActionRegistry();
  const registerAction = action => registry.register(action);

  // Inline stroke icons (24×24). The <svg> wrapper sets stroke/fill; these are the paths.
  const icons = {
    text: '<path d="M4 5h16"/><path d="M12 5v14"/>',
    equation: '<path d="M6 5h8"/><path d="M14 5l-9 15"/>',
    plot: '<path d="M3 21V3"/><path d="M3 21h18"/><path d="M7 15l4-5 3 3 5-7"/>',
    code: '<path d="M9 6l-5 6 5 6"/><path d="M15 6l5 6-5 6"/>',
    undo: '<path d="M8 9L3 14l5 5"/><path d="M3 14h11a6 6 0 010 12h-4"/>',
    redo: '<path d="M16 9l5 5-5 5"/><path d="M21 14H10a6 6 0 000 12h4"/>',
    run: '<path d="M7 5l12 7-12 7z"/>',
    interrupt: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
    addCurve: '<path d="M12 5v14M5 12h14"/>',
    removeCurve: '<path d="M5 12h14"/>'
  };

  function mathTemplate(id, label, latex, shortcut) {
    return {
      id, tab: 'insert', group: 'functions', label, shortcut, size: 'small',
      when: ctx => ctx.mathFieldFocused,
      run: ctx => ctx.insert(latex)
    };
  }

  // Structures and functions (editable templates, never static text).
  registerAction(mathTemplate('insert.fraction', 'Fraction', '\\frac{#@}{#?}', '/'));
  registerAction(mathTemplate('insert.sqrt', 'Square root', '\\sqrt{#@}', '\\sqrt'));
  registerAction(mathTemplate('insert.power', 'Power', '#@^{#?}', '^'));
  registerAction(mathTemplate('insert.sin', 'Sine', '\\sin(#@)', ''));
  registerAction(mathTemplate('insert.cos', 'Cosine', '\\cos(#@)', ''));
  registerAction(mathTemplate('insert.tan', 'Tangent', '\\tan(#@)', ''));
  registerAction(mathTemplate('insert.log', 'Log', '\\log_{#?}(#@)', ''));
  registerAction(mathTemplate('insert.ln', 'Ln', '\\ln(#@)', ''));
  registerAction(mathTemplate('insert.integral', 'Integral', '\\int #@\\, d#?', ''));
  registerAction(mathTemplate('insert.sum', 'Sum', '\\sum_{#?}^{#?} #@', ''));

  // Common symbols (a sample; MathLive's virtual keyboard covers the rest).
  for (const [id, label, latex] of [['insert.alpha', 'α', '\\alpha'], ['insert.beta', 'β', '\\beta'], ['insert.pi', 'π', '\\pi']]) {
    registerAction({
      id, tab: 'insert', group: 'symbols', label, shortcut: '', size: 'small',
      when: ctx => ctx.mathFieldFocused,
      run: ctx => ctx.insert(latex)
    });
  }

  // Common units (a sample; replaces the current unit/conversion selects).
  for (const unit of ['m', 'cm', 'km', 's', 'min', 'h', 'kg', 'g', 'm/s', 'km/h']) {
    registerAction({
      id: 'insert.unit.' + unit, tab: 'insert', group: 'units', label: unit, shortcut: '', size: 'small',
      when: ctx => ctx.mathFieldFocused,
      run: ctx => ctx.insert('\\,\\mathrm{' + unit + '}')
    });
  }

  // Home tab — insert blocks (large buttons, like Word's primary actions).
  const homeInsert = [
    ['text', 'Text', 'text'],
    ['math', 'Equation', 'equation'],
    ['plot', 'Plot', 'plot'],
    ['python', 'Code', 'code']
  ];
  for (const [type, label, icon] of homeInsert) {
    registerAction({
      id: 'home.add.' + type, tab: 'home', group: 'insert', label, icon, shortcut: '', size: 'large',
      // Python blocks are not part of the document model yet (milestone 2).
      when: type === 'python' ? () => false : undefined,
      run: ctx => ctx.addBlock(type)
    });
  }

  // Home tab — history.
  registerAction({ id: 'home.undo', tab: 'home', group: 'history', label: 'Undo', icon: 'undo', size: 'small', when: ctx => ctx.canUndo, run: ctx => ctx.undo() });
  registerAction({ id: 'home.redo', tab: 'home', group: 'history', label: 'Redo', icon: 'redo', size: 'small', when: ctx => ctx.canRedo, run: ctx => ctx.redo() });

  // Plot tab.
  registerAction({ id: 'plot.addCurve', tab: 'plot', group: 'curves', label: 'Add curve', icon: 'addCurve', size: 'small', when: ctx => ctx.plotBlockActive, run: ctx => ctx.addCurve() });
  registerAction({ id: 'plot.removeCurve', tab: 'plot', group: 'curves', label: 'Remove curve', icon: 'removeCurve', size: 'small', when: ctx => ctx.plotBlockActive, run: ctx => ctx.removeCurve() });

  // Code tab.
  registerAction({ id: 'code.run', tab: 'code', group: 'run', label: 'Run', icon: 'run', size: 'large', when: ctx => ctx.pythonBlockActive, run: ctx => ctx.runCurrentBlock() });
  registerAction({ id: 'code.interrupt', tab: 'code', group: 'run', label: 'Interrupt', icon: 'interrupt', size: 'large', when: ctx => ctx.pythonBlockActive, run: ctx => ctx.interrupt() });

  globalThis.MathRibbon = { SelectionContext, ActionRegistry, registry, registerAction, icons };
})();
