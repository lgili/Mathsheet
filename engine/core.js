'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MathCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function sourceFromNodes(nodes) {
    if (!Array.isArray(nodes)) throw new Error('Invalid expression.');
    return nodes.map(node => {
      if (node.type === 'text') return String(node.value || '');
      if (node.type === 'fraction') return '((' + String(node.numerator || '') + ')/(' + String(node.denominator || '') + '))';
      if (node.type === 'power') return '((' + String(node.base || '') + ')^(' + String(node.exponent || '') + '))';
      throw new Error('Unknown mathematical element.');
    }).join('');
  }

  function tokenize(source) {
    const tokens = [];
    let i = 0;
    while (i < source.length) {
      const rest = source.slice(i);
      const space = /^\s+/.exec(rest);
      if (space) { i += space[0].length; continue; }
      const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
      if (number) { tokens.push({ type: 'number', value: Number(number[0]) }); i += number[0].length; continue; }
      const name = /^[A-Za-z_][A-Za-z_0-9]*/.exec(rest);
      if (name) { tokens.push({ type: 'name', value: name[0] }); i += name[0].length; continue; }
      const char = source[i];
      if ('+-*/^()'.includes(char)) { tokens.push({ type: char }); i++; continue; }
      if (char === '×' || char === '·') { tokens.push({ type: '*' }); i++; continue; }
      if (char === '÷') { tokens.push({ type: '/' }); i++; continue; }
      throw new Error('Unrecognized character: ' + char);
    }
    tokens.push({ type: 'end' });
    return tokens;
  }

  function evaluateExpression(source, environment = Object.create(null)) {
    const tokens = tokenize(source);
    let pos = 0;
    const peek = () => tokens[pos].type;
    const take = type => {
      if (peek() !== type) throw new Error('Expected: ' + type + '.');
      return tokens[pos++];
    };
    function primary() {
      if (peek() === 'number') return take('number').value;
      if (peek() === 'name') {
        const name = take('name').value;
        if (!Object.prototype.hasOwnProperty.call(environment, name)) throw new Error('Undefined symbol: ' + name + '.');
        return environment[name];
      }
      if (peek() === '(') { take('('); const value = addition(); take(')'); return value; }
      throw new Error('Incomplete or invalid expression.');
    }
    function power() { const base = primary(); return peek() === '^' ? (take('^'), checked(base ** unary())) : base; }
    function unary() { if (peek() === '+') { take('+'); return unary(); } if (peek() === '-') { take('-'); return checked(-unary()); } return power(); }
    function multiply() {
      let value = unary();
      while (peek() === '*' || peek() === '/') {
        const op = tokens[pos++].type;
        const right = unary();
        if (op === '/' && right === 0) throw new Error('Division by zero.');
        value = checked(op === '*' ? value * right : value / right);
      }
      return value;
    }
    function addition() {
      let value = multiply();
      while (peek() === '+' || peek() === '-') {
        const op = tokens[pos++].type;
        const right = multiply();
        value = checked(op === '+' ? value + right : value - right);
      }
      return value;
    }
    const result = addition();
    if (peek() !== 'end') throw new Error('Missing operator or invalid expression.');
    return checked(result);
  }
  function checked(value) { if (!Number.isFinite(value)) throw new Error('Result not finite or outside the numeric range.'); return value; }
  function evaluateDocument(doc) {
    if (!doc || doc.version !== 1 || !Array.isArray(doc.blocks)) throw new Error('Unrecognized document format.');
    const env = Object.create(null);
    return doc.blocks.map(block => {
      if (block.type === 'text') return { id: block.id, status: 'text' };
      try {
        if (block.type === 'definition') {
          const name = String(block.symbol || '').trim();
          if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) throw new Error('Invalid variable name. Use letters, numbers and _; start with a letter or _.');
          if (Object.prototype.hasOwnProperty.call(env, name)) throw new Error('Symbol already defined: ' + name + '.');
          const value = evaluateExpression(sourceFromNodes(block.expression), env);
          env[name] = value;
          return { id: block.id, status: 'ok', value };
        }
        if (block.type === 'evaluation') return { id: block.id, status: 'ok', value: evaluateExpression(sourceFromNodes(block.expression), env) };
        throw new Error('Unknown block type.');
      } catch (error) { return { id: block.id, status: 'error', message: error.message }; }
    });
  }
  return { sourceFromNodes, evaluateExpression, evaluateDocument };
});
