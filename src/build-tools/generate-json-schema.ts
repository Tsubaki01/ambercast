/**
 * Produces the static JSON Schema files that ambercast publishes for tooling
 * outside its TypeScript runtime.
 *
 * This build-tool entry point owns filesystem I/O so core schema modules
 * remain pure. Package export subpaths expose the static outputs to IDEs and
 * non-JavaScript consumers without making this executable public API.
 *
 * Imports remain free of filesystem side effects. The main-program guard
 * confines writes to direct execution, while the injected writer lets tests
 * compare output bytes without touching disk.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as url from 'node:url';
import { getConfigJsonSchema } from '../core/config/json-schema.js';
import { getGroundingJsonSchema, getPlanJsonSchema } from '../core/ir/json-schema.js';

/**
 * Writes all public JSON Schema documents through an injected file writer.
 *
 * Writer injection keeps byte-level output tests independent of the
 * filesystem. Directory creation stays with the direct-execution caller, so a
 * fake writer needs no directory.
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
  deps.writeFile(join(deps.outDir, 'config.schema.json'), JSON.stringify(getConfigJsonSchema()));
}

/**
 * Only direct execution writes schema files, keeping imports side-effect free.
 * Module-relative output stays independent of the caller's directory, and
 * recursive creation restores the generated directory after tsdown cleans it.
 */
if (import.meta.url === url.pathToFileURL(process.argv[1] ?? '').href) {
  const outDir = url.fileURLToPath(new URL('./schema', import.meta.url));
  mkdirSync(outDir, { recursive: true });
  writeJsonSchemaFiles({
    outDir,
    writeFile: (path, content) => writeFileSync(path, content),
  });
}
