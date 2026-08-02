/**
 * Produces the static JSON Schema files that ambercast publishes for tooling
 * outside its TypeScript runtime.
 *
 * This is a build-tool entry point, not a `core/` module: it is allowed to
 * depend on `node:fs` and the core IR schemas, whereas core must never perform
 * filesystem I/O. After this issue's implementation phase wires it into
 * tsdown, the real executable will create `dist/schema` relative to this
 * module and write `plan.schema.json` and `grounding.schema.json`. Package
 * export subpaths will make those static files reachable by IDEs and
 * non-JavaScript consumers without making this executable itself public API.
 *
 * This docs-first scaffold deliberately performs none of that I/O. Its guard
 * and path-resolution shape exist so importing the module in its later unit
 * tests cannot touch the filesystem, while executing the built entry will be
 * the only route that receives real Node filesystem dependencies. The helper
 * below is dependency-injected for byte-exact tests; the executable will
 * supply `fs.writeFileSync` only after the reviewed test phase.
 */
import * as url from 'node:url';

/**
 * Writes both public IR JSON Schema documents through an injected file writer.
 *
 * In the implementation phase, this function will obtain the two schema
 * objects from the pure core getters, serialize each with exactly
 * `JSON.stringify(...)`, and call `deps.writeFile` once for each of
 * `plan.schema.json` and `grounding.schema.json` within `deps.outDir`. It
 * accepts the writer rather than importing `node:fs` so a unit test can
 * capture `(path, content)` pairs, assert byte-for-byte equality with the
 * getters, and repeat generation without environmental variation. Directory
 * creation is deliberately outside this helper: its caller owns preparing
 * the real output directory, while a fake writer needs no directory at all.
 *
 * @param deps - The output directory and synchronous writer supplied by the
 * build entry point or a test double.
 */
export function writeJsonSchemaFiles(deps: {
  writeFile: (path: string, content: string) => void;
  outDir: string;
}): void {
  void deps;
  throw new Error('not implemented');
}

/**
 * Runs only when Node executes this module as the schema-generator program.
 *
 * `pathToFileURL(process.argv[1] ?? '').href` compares the invoking script as
 * a URL with `import.meta.url`, avoiding accidental writes when unit tests
 * import the helper. The future implementation converts
 * `new URL('./schema', import.meta.url)` to a filesystem path, creates it with
 * `fs.mkdirSync(outDir, { recursive: true })` because tsdown cleans `dist/`
 * before each build, and then invokes `writeJsonSchemaFiles` with
 * `fs.writeFileSync`. Resolving from `import.meta.url`, not `process.cwd()`,
 * makes the published output independent of the caller's current directory.
 */
if (import.meta.url === url.pathToFileURL(process.argv[1] ?? '').href) {
  const outDir = url.fileURLToPath(new URL('./schema', import.meta.url));
  void outDir;
}
