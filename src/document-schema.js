'use strict';
// Validation of the document the webview returns to the VS Code buffer.
//
// Kept separate from extension.js so it can be tested without the VS Code host: only
// shape rules live here. The webview is the only source of these messages, but a
// malformed document must never reach the user's file or crash the editor.
//
// The legacy format (without `layout`) is still accepted: the spatial worksheet uses
// `layout: "canvas"` with `text`, `math` and `plot` blocks; the older sheet uses
// `text`, `definition` and `evaluation` blocks.

const MAX_CONTENT = 2_000_000;
const MAX_BLOCKS = 1000;
const MAX_CURVES = 6;

const CANVAS_TYPES = ['text', 'math', 'plot'];
const BLOCK_TYPES = ['text', 'definition', 'evaluation'];

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = value => typeof value === 'string';
// min/max arrive as a number from the sheet and as text in older files. Empty text is a
// legitimate state while the user is editing the field; any other text must be numeric.
const isIntervalValue = value => typeof value === 'number'
  ? Number.isFinite(value)
  : isText(value) && (value.trim() === '' || Number.isFinite(Number(value)));

function validateBlock(block, index, canvas) {
  if (!isObject(block)) return 'block ' + index + ' is not an object';
  if (!isText(block.id) || !block.id.trim()) return 'block ' + index + ' has no identifier';
  const allowed = canvas ? CANVAS_TYPES : BLOCK_TYPES;
  if (!allowed.includes(block.type)) return 'block ' + index + ' has an unknown type: ' + String(block.type);
  switch (block.type) {
    case 'text':
      if (!isText(block.text)) return 'text block ' + index + ' has no text';
      break;
    case 'math':
      if (!isText(block.latex)) return 'math block ' + index + ' has no expression';
      if (block.convertTo !== undefined && !isText(block.convertTo)) return 'block ' + index + ' has an invalid conversion';
      break;
    case 'plot': {
      if (!Array.isArray(block.curves)) return 'plot block ' + index + ' has no curves';
      if (block.curves.length > MAX_CURVES) return 'plot block ' + index + ' has more than ' + MAX_CURVES + ' curves';
      for (const [position, curve] of block.curves.entries()) {
        if (!isObject(curve)) return 'curve ' + position + ' of block ' + index + ' is not an object';
        if (!isText(curve.latex)) return 'curve ' + position + ' of block ' + index + ' has no expression';
      }
      if (block.variable !== undefined && !isText(block.variable)) return 'block ' + index + ' has an invalid horizontal variable';
      // min/max accept a number (as the sheet writes) or numeric text (older files).
      for (const key of ['min', 'max']) {
        if (block[key] !== undefined && !isIntervalValue(block[key])) return 'block ' + index + ' has an invalid ' + key;
      }
      break;
    }
    case 'definition':
      if (!isText(block.symbol)) return 'definition block ' + index + ' has no symbol';
      // No break: definition and evaluation share the expression requirement.
    case 'evaluation':
      if (!Array.isArray(block.expression)) return 'block ' + index + ' has no expression';
      break;
    default:
      break;
  }
  return null;
}

function validateDocumentContent(content) {
  if (!isText(content)) return { ok: false, reason: 'the content is not text' };
  if (content.length > MAX_CONTENT) return { ok: false, reason: 'the document exceeds ' + MAX_CONTENT + ' characters' };
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return { ok: false, reason: 'the document is not valid JSON' };
  }
  if (!isObject(parsed)) return { ok: false, reason: 'the document is not an object' };
  if (parsed.version !== 1) return { ok: false, reason: 'unsupported document version: ' + String(parsed.version) };
  if (parsed.layout !== undefined && parsed.layout !== 'canvas') return { ok: false, reason: 'unknown layout: ' + String(parsed.layout) };
  if (!Array.isArray(parsed.blocks)) return { ok: false, reason: 'the document has no block list' };
  if (parsed.blocks.length > MAX_BLOCKS) return { ok: false, reason: 'the document exceeds ' + MAX_BLOCKS + ' blocks' };
  const canvas = parsed.layout === 'canvas';
  const identifiers = new Set();
  for (const [index, block] of parsed.blocks.entries()) {
    const problem = validateBlock(block, index, canvas);
    if (problem) return { ok: false, reason: problem };
    // The engine indexes results by identifier: a duplicate would overwrite the
    // other block's result.
    if (identifiers.has(block.id)) return { ok: false, reason: 'duplicate identifier: ' + block.id };
    identifiers.add(block.id);
  }
  return { ok: true, document: parsed };
}

module.exports = { validateDocumentContent, MAX_CONTENT, MAX_BLOCKS, MAX_CURVES };
