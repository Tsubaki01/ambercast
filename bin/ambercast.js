#!/usr/bin/env node
// Thin, published entry point. Kept as a separate file (rather than pointing
// package.json's "bin" field straight at dist/cli.js) so npm pack always
// ships a stable, human-readable executable path — see
// .claude/impl/issue-10-plan.md ("Decisions") for why this reading of the
// design doc was chosen. Explicitly imports and calls main(): relying on an
// import.meta.url entry-point guard inside the bundled module doesn't work
// here, since process.argv[1] identifies this shim, not dist/cli.js.
import { main } from '../dist/cli.js';

main();
