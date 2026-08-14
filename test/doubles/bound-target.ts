import type { ElementRef, Fingerprint } from '../../src/core/ir/schema.js';
import type { BoundElement } from '../../src/ports/browser.js';

/**
 * Creates the serializable shape used when a test needs a browser-bound target.
 *
 * Browser fakes enforce actual binding provenance privately, so this helper is
 * limited to arranging expected actions and assertions without duplicating
 * that structural fixture across usecase suites.
 */
export function boundTarget(ref: ElementRef, fingerprint: Fingerprint): BoundElement {
  return { ref, fingerprint };
}
