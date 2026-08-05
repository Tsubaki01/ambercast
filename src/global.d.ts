// `tsdown.config.js` injects __VERSION__ into the built artifact, and
// `vitest.config.ts` mirrors that injection while tests load unbundled source.
// This avoids a runtime package.json read whose relative path resolves
// differently in those two execution contexts.
declare const __VERSION__: string;
