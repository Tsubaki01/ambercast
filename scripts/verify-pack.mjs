#!/usr/bin/env node
// Automated replacement for eyeballing `npm pack --dry-run` output by hand.
// Fails the build if the packed tarball is missing the built CLI/library
// output or if bin/ambercast.js loses its executable bit, guarding the
// packaging regression fixed in issue #10.
import { execFileSync } from 'node:child_process';

const REQUIRED_FILES = [
  'dist/index.js',
  'dist/index.d.ts',
  'dist/cli.js',
  'bin/ambercast.js',
  'dist/schema/plan.schema.json',
  'dist/schema/grounding.schema.json',
];
const EXECUTABLE_FILES = ['bin/ambercast.js'];

const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
  encoding: 'utf8',
});
const [manifest] = JSON.parse(output);
const files = new Map(manifest.files.map((entry) => [entry.path, entry]));

const errors = [];

for (const path of REQUIRED_FILES) {
  if (!files.has(path)) {
    errors.push(`missing from packed tarball: ${path}`);
  }
}

for (const path of EXECUTABLE_FILES) {
  const entry = files.get(path);
  if (entry && (entry.mode & 0o111) === 0) {
    errors.push(`not executable in packed tarball: ${path} (mode ${entry.mode.toString(8)})`);
  }
}

if (errors.length > 0) {
  console.error('verify-pack: packed tarball failed verification:');
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

console.log(`verify-pack: OK (${REQUIRED_FILES.length} required files present and correctly moded)`);
