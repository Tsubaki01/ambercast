import pkg from '../../../package.json';

/**
 * The published npm package's version, read directly from the repository root's `package.json`
 * (the published `ambercast` package, not this static site's own private `package.json`) so the
 * footer and header version labels move with an actual release-please release instead of a
 * hand-maintained literal that silently drifts out of date.
 */
export const npmVersion: string = pkg.version;
