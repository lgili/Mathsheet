import { ComputeEngine } from '@cortex-js/compute-engine';

// Rebuild a fresh scope on every edit, so changed or invalid definitions cannot
// leave a stale value in a later result.
export function evaluateCanvas(document) {
  if (!document || document.version !== 1 || document.layout !== 'canvas' || !Array.isArray(document.blocks)) {
    throw new Error('Invalid spatial worksheet format.');
  }
  const ce = new ComputeEngine();
  const defined = new Set();
  const ordered = document.blocks.map((block, index) => ({ block, index }))
    .filter(({ block }) => block.type === 'math' || block.type === 'plot')
    .sort((a, b) => Number(a.block.y || 0) - Number(b.block.y || 0) || Number(a.block.x || 0) - Number(b.block.x || 0) || a.index - b.index);
  const results = Object.create(null);
  for (const { block } of ordered) {
    if (block.type === 'plot') {
      results[block.id] = evaluatePlot(ce, defined, block);
      continue;
    }
    const raw = String(block.latex || '').trim();
    if (!raw) { results[block.id] = { status: 'empty' }; continue; }
    try {
      // A trailing equals sign is an evaluation request. A complete equality
      // remains a different mathematical statement and is deliberately rejected.
      const source = raw.endsWith('=') && !raw.endsWith(':=') ? raw.slice(0, -1).trim() : raw;
      if (!source) throw new Error('Type an expression before the =.');
      const expr = ce.parse(source);
      if (expr.errors.length) throw new Error('Incomplete or unrecognized expression.');
      if (expr.operator === 'Assign') {
        const parts = expr.ops;
        const name = parts?.[0]?.json;
        if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) {
          throw new Error('Define a simple variable, e.g. a:=20.');
        }
        if (defined.has(name)) throw new Error('Variable already defined: ' + name + '.');
        const rhs = parts[1];
        if (!rhs || rhs.errors.length) throw new Error('Incomplete definition.');
        validateUnits(ce, rhs.json);
        requireKnownUnits(ce, source, defined);
        const missing = missingVariables(rhs, defined);
        if (missing.length) throw new Error('Define first: ' + missing.join(', ') + '.');
        const evaluated = rhs.evaluate();
        const value = finiteRealOrQuantity(evaluated);
        ce.assign(name, evaluated);
        defined.add(name);
        results[block.id] = { status: 'ok', kind: 'definition', ...value, symbol: name };
      } else {
        if (expr.operator === 'Equal') throw new Error('Use := to define; a trailing = to evaluate.');
        validateUnits(ce, expr.json);
        requireKnownUnits(ce, source, defined);
        const missing = missingVariables(expr, defined);
        if (missing.length) throw new Error('Define first: ' + missing.join(', ') + '.');
        let evaluated = expr.evaluate();
        if (expr.operator === 'Add' && incompatibleAddends(ce, expr.ops)) {
          throw new Error('Cannot add quantities with incompatible dimensions.');
        }
        if (block.convertTo) {
          const target = ce.parse('\\mathrm{' + block.convertTo + '}');
          validateUnits(ce, ['UnitConvert', expr.json, target.json]);
          evaluated = ce.box(['UnitConvert', expr.json, target.json]).evaluate();
          if (evaluated.operator === 'Error') throw new Error('The chosen unit is incompatible with the result.');
        }
        const value = finiteRealOrQuantity(evaluated);
        results[block.id] = { status: 'ok', kind: 'evaluation', ...value };
      }
    } catch (error) {
      results[block.id] = { status: 'error', message: error.message || String(error) };
    }
  }
  return results;
}

function missingVariables(expr, defined) {
  const symbols = new Set();
  function visit(node) {
    if (typeof node === 'string') { symbols.add(node); return; }
    if (!Array.isArray(node)) return;
    if (node[0] === 'Quantity') { visit(node[1]); return; }
    if (node[0] === 'UnitConvert') { visit(node[1]); return; }
    for (const operand of node.slice(1)) visit(operand);
  }
  visit(expr.json);
  const free = new Set(expr.freeVariables);
  return [...symbols].filter(symbol => free.has(symbol) && !defined.has(symbol));
}

// A misspelled unit is parsed as a free symbol: 2\,\mathrm{foobar} becomes 2·foobar.
// Without this check the user would be told to define a variable when the real
// problem is the unit name, which is the mistake the units experiment is meant to
// explain clearly.
const UNIT_NAME = /^[A-Za-z]+(?:\/[A-Za-z]+)?$/;
function requireKnownUnits(ce, source, defined) {
  const unknown = [];
  for (const match of String(source ?? '').matchAll(/\\mathrm\{([^{}]*)\}/g)) {
    const name = match[1].trim();
    if (!UNIT_NAME.test(name) || defined.has(name) || unknown.includes(name)) continue;
    if (ce.parse('1\\,\\mathrm{' + name + '}').json?.[0] !== 'Quantity') unknown.push(name);
  }
  if (unknown.length) throw new Error('Unknown unit: ' + unknown.join(', ') + '.');
}

// Validates unit names already present in the parsed tree. A name made up in LaTeX
// never reaches here — it becomes a symbol and is caught by requireKnownUnits — but a
// conversion target comes from the file's `convertTo` field and is inserted as a unit,
// so this is the path that rejects a conversion to a nonexistent unit.
function validateUnits(ce, node) {
  function unitNames(unit) {
    if (typeof unit === 'string') return [unit];
    if (Array.isArray(unit)) return unit.slice(1).flatMap(unitNames);
    return [];
  }
  function walk(part) {
    if (!Array.isArray(part)) return;
    if (part[0] === 'Quantity' || part[0] === 'UnitConvert') {
      for (const name of unitNames(part[2])) {
        if (ce.box(['UnitDimension', name]).evaluate().operator !== 'List') {
          throw new Error('Unknown unit: ' + name + '.');
        }
      }
      walk(part[1]);
      return;
    }
    for (const operand of part.slice(1)) walk(operand);
  }
  walk(node);
}

function incompatibleAddends(ce, operands) {
  const dimensions = operands.map(operand => {
    const value = operand.evaluate();
    if (value.operator !== 'Quantity') return typeof value.re === 'number' && Number.isFinite(value.re) ? 'dimensionless' : null;
    return JSON.stringify(ce.box(['UnitDimension', value.ops[1].json]).evaluate().json);
  });
  return dimensions.every(Boolean) && new Set(dimensions).size > 1;
}

function finiteRealOrQuantity(expr) {
  if (expr.operator === 'Quantity') {
    const amount = expr.ops?.[0];
    const value = amount?.re;
    if (typeof value === 'number' && Number.isFinite(value) && amount.im === 0) {
      return { value, unit: expr.ops[1].json, latex: expr.latex };
    }
  } else {
    const value = expr.re;
    if (typeof value === 'number' && Number.isFinite(value) && expr.im === 0) {
      return { value, latex: expr.latex };
    }
  }
  throw new Error('Result not computed: check for incompatible units or an invalid expression.');
}

function evaluatePlot(ce, defined, block) {
  try {
    const variable = String(block.variable || 'x').trim();
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(variable)) throw new Error('Use a simple horizontal variable, e.g. x.');
    const min = String(block.min).trim() === '' ? NaN : Number(block.min);
    const max = String(block.max).trim() === '' ? NaN : Number(block.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) throw new Error('Define a valid range: minimum < maximum.');
    const curves = Array.isArray(block.curves) ? block.curves : [];
    if (!curves.length || curves.length > 6) throw new Error('Add between one and six curves.');
    const allowed = new Set(defined);
    allowed.add(variable);
    const series = curves.map((curve, index) => {
      const latex = String(curve.latex || '').trim();
      if (!latex) throw new Error('Enter the expression for curve ' + (index + 1) + '.');
      const points = [];
      ce.pushScope();
      try {
        // Parse within the local scope. Parsing before pushScope can bind the
        // plot variable to the outer scope when Compute Engine evaluates it.
        ce.assign(variable, min);
        const expr = ce.parse(latex);
        if (expr.errors.length || expr.operator === 'Assign' || expr.operator === 'Equal') throw new Error('Invalid expression in curve ' + (index + 1) + '.');
        validateUnits(ce, expr.json);
        requireKnownUnits(ce, latex, allowed);
        const missing = missingVariables(expr, allowed);
        if (missing.length) throw new Error('Define first: ' + missing.join(', ') + '.');
        for (let i = 0; i <= 120; i++) {
          const x = min + (max - min) * i / 120;
          ce.assign(variable, x);
          const value = expr.N();
          const y = value.operator === 'Quantity' ? NaN : value.re;
          points.push({ x, y: typeof y === 'number' && Number.isFinite(y) && value.im === 0 ? y : null });
        }
      } finally { ce.popScope(); }
      if (!points.some(point => point.y !== null)) throw new Error('Curve ' + (index + 1) + ' has no real results in this range.');
      return { id: curve.id || String(index), name: String(curve.name || 'Curve ' + (index + 1)), latex, points };
    });
    return { status: 'ok', kind: 'plot', variable, min, max, series };
  } catch (error) {
    return { status: 'error', kind: 'plot', message: error.message || String(error) };
  }
}
