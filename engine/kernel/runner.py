#!/usr/bin/env python3
"""
Math kernel runner.

Reads JSON-RPC (one message per line) from stdin and writes responses to stdout.
`stderr` is reserved for the runner's own diagnostics (e.g. a crash), never for user
output: a block's output is captured and returned in the response body.

Value contract (sheet <-> Python bridge) — DESIGN.md §3.5:

    {"type": "number",  "value": 12.5}
    {"type": "boolean", "value": true}
    (reserved for the future: quantity, list, matrix, string)

Methods supported via stdin:
    - `run`  → runs the block and returns outputs/streams/displays/warnings.
    - `ping` → returns {"status": "ok"} for a liveness check.

A persistent session is shared across `run` calls (notebook-style): Python assignments
in one block are visible to the next. The host resets it by restarting the process.

`interrupt` and `restart` do NOT travel over stdin: the host sends SIGINT to the process
(the running block raises KeyboardInterrupt) and respawns to restart.
"""
import contextlib
import io
import json
import keyword
import math
import re
import sys
import traceback

NAME_RE = re.compile(r'^[A-Za-z_][A-Za-z_0-9]*$')
# Names that cannot be bound/exported: `export` is the block API, `inputs`/`__builtins__`
# belong to the namespace, and Python keywords break the syntax.
RESERVED = {'export', 'inputs', '__builtins__'}


def to_python(value):
    """Converts a bridge-schema value into a Python object."""
    kind = value.get('type')
    if kind == 'number':
        number = float(value['value'])
        # Keep integers as int for friendly reading (20 instead of 20.0).
        return int(number) if number.is_integer() else number
    if kind == 'boolean':
        return bool(value['value'])
    # quantity/list/matrix/string only in future stages.
    raise TypeError('Unsupported input type in this version: ' + repr(kind))


def to_bridge(value):
    """Converts a Python object into the bridge schema."""
    if isinstance(value, bool):
        return {'type': 'boolean', 'value': value}
    if isinstance(value, (int, float)):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError('Non-finite result: ' + repr(value))
        return {'type': 'number', 'value': int(value) if isinstance(value, int) else number}
    raise TypeError(
        'Unsupported type to export: ' + type(value).__name__
        + '. This version accepts only int, float and bool.'
    )


def build_export(outputs):
    """Creates the export() function exposed inside the block."""

    def export(**kwargs):
        for name, value in kwargs.items():
            if not NAME_RE.match(name):
                raise ValueError('Invalid name to export: ' + repr(name) + '.')
            if keyword.iskeyword(name) or name in RESERVED:
                raise ValueError('Reserved name to export: ' + repr(name) + '.')
            outputs.append({'name': name, 'value': to_bridge(value)})

    return export


def run_block(code, inputs, session):
    """Runs a block against the shared session and returns the contract result.

    `session` persists across `run` calls (notebook-style): Python assignments in one
    block are visible to the next. Sheet `inputs` are injected into `session` on each
    block, so the sheet (above) stays authoritative over the names it defines.
    """
    skipped = []

    for name, value in inputs.items():
        if keyword.iskeyword(name) or name in RESERVED:
            skipped.append(name + ' (reserved name)')
            continue
        try:
            session[name] = to_python(value)
        except TypeError as exc:
            skipped.append(name + ' (' + str(exc) + ')')

    outputs = []
    session['export'] = build_export(outputs)

    stdout = io.StringIO()
    stderr = io.StringIO()
    # Capture the user's print/warnings so they don't corrupt the JSON stdout stream.
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        exec(code, session)

    streams = []
    if stdout.getvalue():
        streams.append({'name': 'stdout', 'text': stdout.getvalue()})
    if stderr.getvalue():
        streams.append({'name': 'stderr', 'text': stderr.getvalue()})

    result = {'outputs': outputs, 'streams': streams, 'displays': []}
    if skipped:
        result['warnings'] = [
            'Sheet symbols ignored in this block: ' + ', '.join(skipped) + '.'
        ]
    return result


def write(message):
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def main():
    session = {}
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError as exc:
            write({'jsonrpc': '2.0', 'id': None, 'error': {
                'ename': 'ProtocolError', 'evalue': 'Invalid JSON', 'traceback': str(exc)}})
            continue

        request_id = message.get('id')
        method = message.get('method')

        if method == 'ping':
            write({'jsonrpc': '2.0', 'id': request_id, 'result': {'status': 'ok'}})
            continue

        if method != 'run':
            write({'jsonrpc': '2.0', 'id': request_id, 'error': {
                'ename': 'ProtocolError',
                'evalue': 'Unknown method: ' + repr(method),
                'traceback': ''}})
            continue

        try:
            params = message.get('params', {})
            result = run_block(params.get('code', ''), params.get('inputs', {}), session)
            write({'jsonrpc': '2.0', 'id': request_id, 'result': result})
        except KeyboardInterrupt:
            write({'jsonrpc': '2.0', 'id': request_id, 'error': {
                'ename': 'Interrupted',
                'evalue': 'Execution interrupted by the user.',
                'traceback': ''}})
        except BaseException as exc:  # noqa: BLE001 — report any block error
            write({'jsonrpc': '2.0', 'id': request_id, 'error': {
                'ename': type(exc).__name__,
                'evalue': str(exc),
                'traceback': traceback.format_exc()}})


if __name__ == '__main__':
    if hasattr(sys.stdin, 'reconfigure'):
        sys.stdin.reconfigure(encoding='utf-8')
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    main()
