'use strict';
/**
 * Command ribbon — declarative action registry + selection context.
 *
 * Loaded BEFORE canvas.js (it exposes globalThis.MathRibbon). The action gallery is
 * DATA, not code: canvas.js builds the ribbon from `MathRibbon.registry` and feeds
 * `MathRibbon.SelectionContext` with the current selection.
 *
 * Integration (to do in canvas.js, in place of the current toolbar):
 *   1. create `const ctx = new MathRibbon.SelectionContext();`
 *   2. on the sheet's `focusin`/`focusout`, call `ctx.setSelection({ block, mathField })`;
 *   3. set `ctx.delegate` with the concrete operations:
 *        insert(latex), addBlock(type), runCurrentBlock(), interrupt(), undo(), redo(),
 *        addCurve(), removeCurve();
 *   4. build the ribbon: for each tab, `registry.groupsForTab(tab)`, render buttons and
 *      wire `run(ctx)` with the enabled/disabled state from `registry.isEnabled(action, ctx)`.
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

  // ---------------------------------------------------------------------------
  // Default gallery. `run` delegates to the context; none of these actions touch
  // the DOM directly. MathLive placeholders: #@ = cursor, #? = placeholder.
  // ---------------------------------------------------------------------------
  function mathTemplate(id, label, latex, shortcut) {
    return {
      id, tab: 'insert', group: 'functions', label, shortcut,
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
  for (const [id, latex] of [['insert.alpha', '\\alpha'], ['insert.beta', '\\beta'], ['insert.pi', '\\pi']]) {
    registerAction({
      id, tab: 'insert', group: 'symbols', label: latex.slice(1), shortcut: '',
      when: ctx => ctx.mathFieldFocused,
      run: ctx => ctx.insert(latex)
    });
  }

  // Common units (a sample; replaces the current unit/conversion selects).
  for (const unit of ['m', 'cm', 'km', 's', 'min', 'h', 'kg', 'g', 'm/s', 'km/h']) {
    registerAction({
      id: 'insert.unit.' + unit, tab: 'insert', group: 'units', label: unit, shortcut: '',
      when: ctx => ctx.mathFieldFocused,
      run: ctx => ctx.insert('\\,\\mathrm{' + unit + '}')
    });
  }

  // Home tab — insert blocks.
  for (const [type, label] of [['text', 'Text'], ['math', 'Equation'], ['plot', 'Plot'], ['python', 'Code']]) {
    registerAction({
      id: 'home.add.' + type, tab: 'home', group: 'insert', label, shortcut: '',
      run: ctx => ctx.addBlock(type)
    });
  }

  // Home tab — history.
  registerAction({ id: 'home.undo', tab: 'home', group: 'history', label: 'Undo', run: ctx => ctx.undo() });
  registerAction({ id: 'home.redo', tab: 'home', group: 'history', label: 'Redo', run: ctx => ctx.redo() });

  // Plot tab.
  registerAction({ id: 'plot.addCurve', tab: 'plot', group: 'curves', label: '+ Curve', when: ctx => ctx.plotBlockActive, run: ctx => ctx.addCurve() });
  registerAction({ id: 'plot.removeCurve', tab: 'plot', group: 'curves', label: 'Remove curve', when: ctx => ctx.plotBlockActive, run: ctx => ctx.removeCurve() });

  // Code tab.
  registerAction({ id: 'code.run', tab: 'code', group: 'run', label: 'Run', when: ctx => ctx.pythonBlockActive, run: ctx => ctx.runCurrentBlock() });
  registerAction({ id: 'code.interrupt', tab: 'code', group: 'run', label: 'Interrupt', when: ctx => ctx.pythonBlockActive, run: ctx => ctx.interrupt() });

  globalThis.MathRibbon = { SelectionContext, ActionRegistry, registry, registerAction };
})();
