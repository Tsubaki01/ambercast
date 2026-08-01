/**
 * Public library entry point.
 *
 * Deliberately empty for now: `createAmbercast` and the rest of the public
 * API (types, error classes) land with the core/ports/adapters/usecases
 * layers in later issues (see AGENTS.md and the product design docs). This
 * file exists so that `exports["."]` in package.json resolves to a real,
 * buildable ES module from the very first toolchain issue, without
 * inventing product API surface prematurely.
 */
export {};
