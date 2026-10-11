'use strict';
/**
 * PythonKernel — service that runs on the extension HOST (Node.js).
 *
 * Launches `python3 -u engine/kernel/runner.py` and speaks JSON-RPC (one message per
 * line) with it. The webview NEVER talks to Python directly: the webview orchestrator
 * sends `postMessage` to the host, and the host translates it into this service.
 *
 * Contract (see DESIGN.md §3.3):
 *   - `run({ code, inputs })`  → resolves with `{ outputs, streams, displays, warnings? }`
 *                                or rejects with `{ ename, evalue, traceback }`.
 *   - `interrupt()`            → SIGINT to the process (the runner answers with an Interrupted error).
 *   - `restart()`              → kills and starts a fresh process.
 *   - `ping()`                 → checks whether the runner is alive.
 *
 * The lifecycle (discovering the interpreter, first-Run warning, interruption watchdog)
 * lives in the caller (extension.js). Here only the transport and the session.
 *
 * Intended usage (on the host):
 *   const { PythonKernel, STATUS } = require('./engine/python-kernel');
 *   const kernel = new PythonKernel({ runnerPath: path.join(context.extensionPath, 'engine', 'kernel', 'runner.py') });
 *   await kernel.start();
 *   const result = await kernel.run({ code: 'x = a + 1\nexport(y=x)', inputs: { a: { type: 'number', value: 20 } } });
 */
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const STATUS = Object.freeze({
  STARTING: 'starting',
  IDLE: 'idle',
  BUSY: 'busy',
  DEAD: 'dead',
});

class PythonKernel extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} [options.interpreter='python3'] interpreter to launch.
   * @param {string} options.runnerPath absolute path to engine/kernel/runner.py.
   * @param {string} [options.cwd] working directory of the process.
   */
  constructor({ interpreter = 'python3', runnerPath, cwd } = {}) {
    super();
    if (!runnerPath) throw new Error('PythonKernel requires runnerPath (path to engine/kernel/runner.py).');
    this.interpreter = interpreter;
    this.runnerPath = runnerPath;
    this.cwd = cwd;
    this.status = STATUS.STARTING;
    this.proc = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject }
  }

  start() {
    if (this.proc) return Promise.resolve(this);
    return new Promise((resolve, reject) => {
      this.status = STATUS.STARTING;
      this.proc = spawn(this.interpreter, ['-u', this.runnerPath], {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.proc.stdout.setEncoding('utf8');
      this.proc.stdout.on('data', chunk => this.#onData(chunk));
      this.proc.stderr.setEncoding('utf8');
      this.proc.stderr.on('data', chunk => this.emit('diagnostic', String(chunk)));
      this.proc.on('error', error => { this.status = STATUS.DEAD; reject(error); });
      this.proc.on('exit', (code, signal) => this.#onExit(code, signal));
      this.proc.once('spawn', () => { this.status = STATUS.IDLE; resolve(this); });
    });
  }

  /** Runs a Python block. `inputs` uses the bridge schema (DESIGN.md §3.5). */
  run({ code, inputs = {} }) {
    return this.#call('run', { code, inputs });
  }

  /** Checks whether the runner is alive. */
  ping() {
    return this.#call('ping').then(result => result && result.status === 'ok');
  }

  /**
   * Interrupts the running execution. Sends SIGINT; the runner catches KeyboardInterrupt
   * and returns an `Interrupted` error, resolving the pending `run()`.
   * If the code does not react to the signal, the caller should call `restart()` via a watchdog.
   */
  interrupt() {
    if (this.proc && this.status === STATUS.BUSY) {
      try { this.proc.kill('SIGINT'); } catch { /* process already exited */ }
    }
  }

  /** Kills the current process and starts a fresh one (reproducible restart & run-all). */
  async restart() {
    await this.#kill();
    return this.start();
  }

  async dispose() {
    await this.#kill();
  }

  #call(method, params = {}) {
    if (this.status !== STATUS.IDLE) {
      return Promise.reject(new Error(`Kernel is not ready (${this.status}).`));
    }
    const id = this.nextId++;
    this.status = STATUS.BUSY;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.#send({ jsonrpc: '2.0', id, method, params });
    });
  }

  #send(message) {
    this.proc.stdin.write(JSON.stringify(message) + '\n');
  }

  #onData(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.#onMessage(line);
    }
  }

  #onMessage(line) {
    let message;
    try { message = JSON.parse(line); } catch {
      this.emit('diagnostic', 'Invalid kernel response: ' + line);
      return;
    }
    if (message.jsonrpc !== '2.0') return;
    const pending = this.pending.get(message.id);
    if (!pending) { this.emit('diagnostic', 'Response without a matching request: ' + line); return; }
    this.pending.delete(message.id);
    this.status = STATUS.IDLE;
    if (message.error) pending.reject(message.error);
    else pending.resolve(message.result);
  }

  #onExit(code, signal) {
    this.status = STATUS.DEAD;
    const pending = [...this.pending.values()];
    this.pending.clear();
    const reason = new Error(`Python kernel exited (code=${code}, signal=${signal}).`);
    for (const request of pending) request.reject(reason);
    this.emit('exit', { code, signal });
  }

  #kill() {
    if (!this.proc) return Promise.resolve();
    return new Promise(resolve => {
      const proc = this.proc;
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already exited */ }
        resolve();
      }, 1500);
      proc.once('exit', () => { clearTimeout(timer); resolve(); });
      try { proc.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
    });
  }
}

module.exports = { PythonKernel, STATUS };
