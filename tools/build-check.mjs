#!/usr/bin/env node
// Fails when a build artifact committed to the repository is not what the build script
// produces right now.
//
// media/canvas-engine.bundle.js is committed, so the interface checks load a file that a
// stale build could have left behind: editing engine/canvas-core.mjs without running
// `npm run build` would verify the old code and report success. This reads the output
// paths from the build script itself, so a second bundle added later is covered without
// touching this file or the workflow.
//
// Usage: `npm run build:check`. The comparison only makes sense *after* a build —
// comparing a bundle with itself detects nothing — so there is deliberately no option
// to skip the build.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const build = pkg.scripts && pkg.scripts.build;
if (!build) {
  console.log('build:check — package.json has no build script. Check skipped.');
  process.exit(0);
}

// esbuild writes with --outfile=<path> or --outfile <path>; both forms appear in practice.
const artifacts = [...build.matchAll(/--outfile[= ]"?([^"\s]+)"?/g)].map(match => match[1]);
if (!artifacts.length) {
  console.log('build:check — the build script declares no --outfile; nothing to compare.');
  process.exit(0);
}

// What the repository currently has, before the build overwrites it.
const committed = new Map(artifacts.map(file => {
  try { return [file, readFileSync(join(ROOT, file))]; } catch { return [file, null]; }
}));

execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });

let drifted = 0;
for (const file of artifacts) {
  let after = null;
  try { after = readFileSync(join(ROOT, file)); } catch { /* missing */ }
  if (after === null) { drifted++; console.log('missing    ' + file + ' — the build did not produce it'); continue; }
  const previous = committed.get(file);
  if (previous === null) { drifted++; console.log('untracked  ' + file + ' — not in the repository yet'); continue; }
  if (!previous.equals(after)) { drifted++; console.log('stale      ' + file + ' — the build produces different content'); continue; }
  console.log('ok         ' + file + ' matches the build');
}

if (drifted) {
  console.log('\n' + drifted + ' build artifact(s) out of date. Run: npm run build');
  process.exit(1);
}
console.log('\nbuild artifacts match their source.');
