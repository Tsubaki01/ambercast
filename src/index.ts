/*
 * Public library entry point.
 *
 * `package.json`'s `exports["."]` field must resolve to a real, buildable
 * ES module for `import "ambercast"` to succeed at all — a structural
 * requirement independent of the package's public API surface. This empty
 * facade satisfies that requirement without asserting unsupported exports
 * (types, error classes, a factory function).
 */
export {};
