#!/usr/bin/env node
// This published shim provides a stable, human-readable executable path
// instead of exposing dist/cli.js directly through package.json's "bin" field.
// It explicitly imports and calls main() because an import.meta.url entry-point
// guard in the bundled module cannot distinguish this shim from dist/cli.js:
// process.argv[1] identifies this file, not the module performing the check.
import { main } from '../dist/cli.js';

main();
