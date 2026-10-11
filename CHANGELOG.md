# Changelog

## 0.0.2

First public state of the prototype.

- Visual mathematical sheet as a VS Code custom editor, registered for `*.mathdoc`
  documents (view type `mathsheet.sheet`).
- Writing formatted on the sheet itself through MathLive: `^` exponent, `/` fraction,
  `_` subscript.
- Spatial evaluation: top-down and, at the same height, left to right. Moving a region
  can change its dependencies.
- Definitions (`:=`), evaluation (trailing `=`), and clear diagnostics for undefined
  symbols, incomplete expressions, division by zero and complex results.
- Quantities with units, conversions, and dimensional errors, including a conversion
  target read from the document.
- Recalculating plots with up to six named curves per block, sharing the definitions
  above them.
- Versioned `.mathdoc` format validated by `document-schema.js` before anything is
  written to disk.
- Python blocks over JSON-RPC on stdio (`engine/python-kernel.js` plus
  `engine/kernel/runner.py`), shaped after the Jupyter messaging protocol. The blocks
  are not wired to the sheet yet.
- Command ribbon, undo/redo history, and the `Mathsheet: New sheet` command.

Verification: `npm run verify` runs 41 unit tests, checks the three canonical examples
against the engine, and drives 14 interface behaviours in headless Chrome.
