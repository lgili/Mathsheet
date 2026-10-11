# Design — Python blocks + command ribbon

> Design document to guide the implementation of two evolutions of the `math` prototype:
> (1) Python code blocks with a variable bridge between the sheet and Python, and
> (2) a command ribbon ("ribbon") in the Word/Excel/Mathcad style for discovery by clicking.
>
> This document describes **what** to build and **the contracts** between the parts, not the
> implementation line by line. Where a decision is open, it is marked as such.

---

## 1. Agreed decisions

| Theme | Decision |
|---|---|
| Python runtime | **Local subprocess** launched by the extension host, communicating over **JSON-RPC on stdio**. Design the contract already aligned with the Jupyter format so the transport can be swapped later without touching the UI. |
| Units in Python | **v1 with dimensionless scalars only** (`number`, `boolean`). Quantities with units, lists and matrices come in later stages; the bridge schema already reserves room for them. |
| Python state | **One kernel/session shared per document**, notebook style: blocks execute in document order, state persists between blocks. Reproducible default = *restart & run-all*. |

---

## 2. Current context (what these changes touch)

- Evaluation today is **synchronous and inside the webview**: [`media/worksheet.js`](media/worksheet.js) calls `MathCanvas.updateResults(doc)` → [`engine/canvas-core.mjs`](engine/canvas-core.mjs) (bundled as `MathCanvasEngine`) walks the blocks in `(y, x, index)` order, keeps a `Set` of defined symbols and evaluates with the Compute Engine.
- The extension host ([`extension.js`](extension.js)) **does not have the engine**; it only handles the open/save cycle and injects the scripts into the webview.
- The central invariant of the product is: **scope recreated on every edit** and a document reproducible on reopening. Python is imperative and stateful, so it is what strains that invariant the most — hence *restart & run-all* as the default.

Architectural consequences:

- **Python does not run in the webview**, so execution has to leave it and become **asynchronous**.
- The value bridge needs a **stable schema** shared between webview ↔ host ↔ Python.
- The math engine (Compute Engine) stays in the webview for now; the ordering orchestrator stays in the webview; the **Python lifecycle stays in the host**.

---

## 3. Feature A — Python blocks

### 3.1 Data model

New block type in the `.mathdoc` document (`layout: 'canvas'` format):

```json
{
  "id": "…",
  "type": "python",
  "x": 70,
  "y": 800,
  "code": "v = d / t\nexport(velocidade=v)\n"
}
```

- `code` is raw Python text (not LaTeX).
- It takes part in the same top-down / left-right evaluation order as the `math` and `plot` blocks (the `sort` in [`evaluateCanvas`](engine/canvas-core.mjs) is already generic; `python` just has to be included in the filter).

### 3.2 Where Python runs

- A `PythonKernel` service in the extension host (new module, e.g. `engine/python-kernel.js`) is responsible for:
  - discovering the interpreter (`python3` on the `PATH`, configurable via the `math.python.interpreter` setting);
  - launching the process with `-u` (unbuffered) and keeping the session alive;
  - implementing the JSON-RPC protocol below;
  - exposing `status` (`idle | busy | starting | dead`), `run()`, `interrupt()`, `restart()`.

- The webview **does not talk to Python directly**. It sends messages to the host (`postMessage`) and the host translates them for the kernel.

```
webview (order orchestrator)
   │  postMessage { type: 'python.run', blockId, code, inputs }
   ▼
host (extension.js + engine/python-kernel.js)
   │  JSON-RPC (stdin/stdout, line-delimited JSON)
   ▼
python3 -u engine/kernel/runner.py
```

### 3.3 JSON-RPC protocol (host ↔ Python)

Format: **one JSON message per line** on `stdin`/`stdout`. `stderr` is reserved for runner diagnostics (not to be confused with the user's output, which must come in the response body). The fields map 1:1 to Jupyter concepts (`execute_request`/`execute_reply`, `stream`, `execute_result`) to make a future transport swap easier.

**Request (host → Python):**

```json
{"jsonrpc":"2.0","id":17,"method":"run","params":{
  "code":"v = d / t\nexport(velocidade=v)\n",
  "inputs":{"d": {"type":"number","value":1500}, "t": {"type":"number","value":120}}
}}
```

**Success result (Python → host):**

```json
{"jsonrpc":"2.0","id":17,"result":{
  "outputs":[{"name":"velocidade","value":{"type":"number","value":12.5}}],
  "streams":[{"name":"stdout","text":"…"}],
  "displays":[{"mime":"text/plain","data":"…"}]
}}
```

**Error (Python → host):**

```json
{"jsonrpc":"2.0","id":17,"error":{
  "ename":"ZeroDivisionError",
  "evalue":"division by zero",
  "traceback":"…"
}}
```

**Control (process signals, not stdin messages):**

`interrupt` and `restart` do not travel over stdin — the Python main thread is busy
during execution and would not read the message. The host applies them directly to the process:

- **interrupt** → `SIGINT` to the process (the runner catches `KeyboardInterrupt` and returns an `Interrupted` error).
- **restart** → terminates the process and starts a new one.

There is also a **`ping`** method to check whether the runner is alive:

```json
{"jsonrpc":"2.0","id":20,"method":"ping"}
```

Rules:

- `id` is correlated by the host to match the response with the block.
- `outputs` contains only what the block **exports explicitly** (see 3.5).
- `displays` carries rich output (text, later image/PNG from matplotlib); in v1 `text/plain` is enough.
- `warnings` (optional) lists warnings from the runner, e.g. sheet symbols ignored because they are reserved words in Python.

### 3.4 Execution model

- **One session per document.** Python blocks share the same kernel and execute in document order; assignments from one block hold for the following ones.
- **Reproducible default = restart & run-all.** When the document is opened, and by default on every change that affects order or inputs, the orchestrator restarts the kernel and re-executes everything from scratch. This preserves the reproducibility invariant.
- **Explicit Run for heavy work.** Each Python block has a **Run** and an **Interrupt** button. Incremental optimisations ("run from the changed block") come later.
- **Dependency boundary.** Sheet variables defined **above** the block come in as `inputs`; what the block exports becomes a mathematical symbol available **below**.

### 3.5 Variable bridge

#### Value schema (stable contract)

```json
{"type":"number","value":12.5}
{"type":"boolean","value":true}
```

Reserved for later stages (already provided for in the contract, **do not implement in v1**):

```json
{"type":"quantity","value":12.5,"unit":["Divide","m","s"]}
{"type":"list","value":[…]}
{"type":"matrix","value":[…]}
{"type":"string","value":"…"}
```

This schema is the same format that [`finiteRealOrQuantity`](engine/canvas-core.mjs) already produces for `value`/`unit`; the bridge only generalises it with `type`.

#### Sheet → Python

When the block is executed, the host assembles `inputs` with **only the symbols defined above the block** (in evaluation order) and sends them. The runner injects each one as a global variable of the block:

```python
d   # 1500 (came from the sheet)
t   # 120
```

#### Python → sheet

**Explicit** export, never implicit. The runner exposes a function in the block namespace:

```python
export(velocidade=v)
export(media=(a + b) / 2)
```

`export(**kwargs)` validates names against `/^[A-Za-z_][A-Za-z_0-9]*$/`, converts `int`/`float` → `{"type":"number",…}` and `bool` → `{"type":"boolean",…}`, and rejects types not supported in v1 (quantity, lists, `None`, objects) with a clear error.

#### Conflicts and edge cases

- **Name already defined on the sheet:** if Python exports `x` and the sheet already defines `x` above, the block fails with the error "Symbol already defined: x", consistent with the current `defined.has(name)`.
- **Reference to a symbol that does not exist in the block:** Python raises `NameError`, which appears in the block; the sheet below stays marked according to the state (3.6).
- **Python reserved words** (`lambda`, `class`, `import`, …): sheet symbols with those names are **not** injected as globals (it would be a `SyntaxError`); the runner ignores them and records a warning. `export` also rejects those names.
- **`export` as a sheet symbol name:** reserve the name `export` in the block namespace (document it).

### 3.6 Asynchronous orchestration (structural change)

`updateResults` no longer returns a ready object and becomes **asynchronous and stateful**. Each block gains a `status`:

```
ok | error | empty | running | queued | stale
```

- `math`/`plot` blocks stay synchronous via the Compute Engine, as today.
- On reaching a `python` block, the orchestrator sends `python.run`, marks the block `running`, and **waits**; the blocks below become `queued`.
- When the result arrives, it merges the `outputs` into the symbol set and carries on.
- On error or interruption, the dependent blocks below become `stale` (visually "out of date", never an old value looking current — consistent with the README).
- References to names not exported by a Python block become the same "Define first: x" already used by the sheet.

The orchestrator stays in the **webview** (that is where the math engine and the UI are); the host only manages the kernel and translates messages. *(Open decision, documented: moving the whole engine to the host in the future, aligned with the "engine independent of the interface" vision, is possible because the Compute Engine runs on Node — but it is a separate refactor.)*

### 3.7 Lifecycle and interruption

- `interrupt()` tries **SIGINT** on the process (`child.kill('SIGINT')`). If it does not return to `idle` within a short deadline, the host **restarts** the kernel (`restart()`) and marks all Python blocks as `stale`.
- When the document is closed, the host terminates the process.
- Kernel state is exposed in the UI (indicator in the ribbon, section 4).

### 3.8 Reproducibility, safety and errors

- Record the **Python version** in the document (`python: { "version": "3.12.3" }` field) and display/stamp it on the results. A dependency lockfile comes later.
- **Warning on the first Run**: "This document executes Python code on your machine." (arbitrary execution is inherent; it is not a sandbox in v1).
- Tracebacks appear **in the block** of origin, with the full `traceback` in a tooltip/expansion.
- `stdout`/`stderr` output from the block appears as the block's output (not hidden).

---

## 4. Feature B — Command ribbon ("ribbon")

It replaces the lean bar in [`media/canvas.js`](media/canvas.js) (`+ Text`, `+ Equation`, `+ Plot`, units, `Undo`) with a ribbon with tabs, keeping everything in HTML/CSS in the webview (it needs to operate on MathLive fields and blocks, which VS Code's native UI does not do well).

### 4.1 Tabs and groups

| Tab | Groups |
|---|---|
| **Home** | Insert (Text, Equation, Plot, **Code**), History (Undo, Redo) |
| **Insert** | Functions, Symbols, Units |
| **Plot** | Curves (Add/Remove), Axis (variable, minimum, maximum) |
| **Code** | Run, Interrupt, kernel status |
| **Help** | Shortcut cheat sheet |

### 4.2 Declarative action registry

Instead of an `addEventListener` per button, an **action registry** (a gallery as data, not code — testable):

```js
registerAction({
  id: 'insert.sin',
  tab: 'insert',
  group: 'functions',
  label: 'Sine',
  icon: '…',
  shortcut: '\\sin',                       // matching shortcut, shown in the tooltip
  when: ctx => ctx.mathFieldFocused,      // enables/disables by context
  run: ctx => ctx.mathField.insert('\\sin(#@)')
})
```

- The **context** (`ctx`) is exactly what the `focusin` of [`media/canvas.js`](media/canvas.js) already tracks (`activeMathField`, `activeBlock`) — generalise it into a single `SelectionContext`.
- Each action is a command over the context: insert a template into the field, add a block, change a curve, run code, etc.

### 4.3 Function gallery = editable templates

Inserting a function must insert **editable math with the cursor in the right place**, never static text ("one shared definition" principle):

| Button | Inserts |
|---|---|
| Fraction | `\frac{#@}{#?}` |
| Root | `\sqrt{#@}` |
| Power | `#@^{#?}` |
| Sine/Cosine/Tangent | `\sin(#@)` … |
| Log/ln | `\log_{#?}(#@)` … |
| Integral | `\int #@ \, d#?` |
| Summation | `\sum_{#?}^{#?} #@` |

Use `MathfieldElement.insert()` and MathLive placeholders (`#@` cursor, `#?` placeholder).

### 4.4 Discovery **and** teaching of shortcuts

- The ribbon does not replace shortcuts — it **teaches** them. Every button shows the shortcut in the tooltip (e.g. "Fraction — shortcut `/`").
- The ribbon and MathLive's virtual keyboard are complementary: **ribbon = structure/blocks/functions**; **virtual keyboard = symbols**.

### 4.5 Context, states and accessibility

- `disabled` buttons guided by `when(ctx)` (e.g. "Insert unit" only with a math field focused; "Run" only with a Python block).
- Keyboard navigation in the ribbon, `aria-*` on groups/buttons, accessible tooltips.
- Responsive: collapse groups on smaller screens (the current CSS is already responsive).

---

## 5. Implementation order (milestones)

1. **Basic ribbon** (lowest risk, does not touch the engine): Home/Insert tabs + action registry + function gallery. Already includes the "Code" button.
2. **Python block skeleton**: `python` type in the model, `PythonKernel` in the host + `runner.py`, execute and show `stdout`. No bridge yet.
3. **Scalar bridge**: `inputs` (sheet → Python) and `export` (Python → sheet), with conflicts and "Define first".
4. **Asynchronous orchestration**: per-block states, reproducible *restart & run-all*, explicit Run, Interrupt.
5. **Future stages**: units in Python (`quantity`), lists/matrices, dependency lockfile, incremental execution.

---

## 6. Out of scope in v1

- Quantities with units inside Python; lists/matrices in the bridge.
- Rich output (images/matplotlib) — only `text/plain` in v1.
- Execution sandbox; dependency lockfile.
- Moving the math engine to the host (separate refactor, only documented).
- A real Jupyter kernel (the contract is already compatible; the swap is future work).

---

## 7. Risks and mitigation

| Risk | Mitigation |
|---|---|
| Python scope "leaking" silently into the sheet | Explicit export via `export()`; a name conflict raises a clear error. |
| Breaking reproducibility | *restart & run-all* as the default; Python version recorded in the document. |
| Heavy execution freezing the UI | Explicit Run + Interrupt + `stale`; never a silent run-all. |
| Symbol name colliding with a Python reserved word | The runner ignores/reports it instead of a `SyntaxError`; `export` rejects those names. |
| Python process hung/orphaned | `interrupt()` → `restart()` → terminate when the document is closed. |
| Ribbon becoming a monolith of handlers | Declarative action registry + a single `SelectionContext`. |
