/**
 * Produces the static JSON Schema files that ambercast publishes for tooling
 * outside its TypeScript runtime.
 *
 * This is a build-tool entry point, not a `core/` module: it may depend on
 * `node:fs` and the core IR schemas, whereas core must never perform
 * filesystem I/O. The executable writes `plan.schema.json` and
 * `grounding.schema.json` to `dist/schema` resolved relative to this module.
 * Package export subpaths make those static files reachable by IDEs and
 * non-JavaScript consumers without making this executable itself public API.
 *
 * Imports must remain free of filesystem side effects. The main-program guard
 * confines Node filesystem dependencies to direct execution, while the
 * injected writer lets tests compare output bytes without touching disk.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as url from 'node:url';
import { getGroundingJsonSchema, getPlanJsonSchema } from '../core/ir/json-schema.js';

/**
 * Writes both public IR JSON Schema documents through an injected file writer.
 *
 * This helper obtains the two schema objects from the pure core
 * getters, serializes each with exactly `JSON.stringify(...)`, and calls
 * `deps.writeFile` once for each output within `deps.outDir`. It accepts the
 * writer rather than importing `node:fs` so a unit test can capture `(path,
 * content)` pairs, assert byte-for-byte equality with the getters, and repeat
 * generation without environmental variation. Directory creation remains
 * outside this helper: its caller prepares the output directory, while a fake
 * writer needs no directory at all.
 *
 * @param deps - The output directory and synchronous writer supplied by the
 * build entry point or a test double.
 */
export function writeJsonSchemaFiles(deps: {
  writeFile: (path: string, content: string) => void;
  outDir: string;
}): void {
  deps.writeFile(join(deps.outDir, 'plan.schema.json'), JSON.stringify(getPlanJsonSchema()));
  deps.writeFile(join(deps.outDir, 'grounding.schema.json'), JSON.stringify(getGroundingJsonSchema()));
}

/**
 * Direct execution, rather than import, is the only route that may write
 * schema files. The main-program guard prevents test imports from creating
 * side effects, and resolving the output from `import.meta.url` rather than
 * `process.cwd()` keeps its location independent of the caller's directory.
 * The entry recreates the directory recursively because tsdown
 * cleans `dist/` before each build.
 */
if (import.meta.url === url.pathToFileURL(process.argv[1] ?? '').href) {
  const outDir = url.fileURLToPath(new URL('./schema', import.meta.url));
  mkdirSync(outDir, { recursive: true });
  writeJsonSchemaFiles({
    outDir,
    writeFile: (path, content) => writeFileSync(path, content),
  });
}
