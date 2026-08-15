/**
 * Extracts explicit secret-grant lines from normalized test Markdown.
 *
 * Secret use is authorized only by a complete grant line outside CommonMark
 * code constructs. Parsing Markdown here, rather than treating any matching
 * text as a grant, keeps documentation examples and inline code inert without
 * asking the generator or replayer to interpret Markdown independently.
 */
import { fromMarkdown } from 'mdast-util-from-markdown';

import type { NormalizedTestMd } from '#core/ir/normalize.js';
import { SECRET_REF_SOURCE } from './schema.js';

type MarkdownNode = {
  readonly type: string;
  readonly position?: {
    readonly start: { readonly offset: number };
    readonly end: { readonly offset: number };
  };
  readonly children?: readonly MarkdownNode[];
};

const GRANT_LINE_PATTERN = new RegExp(
  `^[ \\t]*@ambercast-secret[ \\t]+(${SECRET_REF_SOURCE})[ \\t]*$`,
);

/**
 * Describes one explicit secret-grant line in normalized test Markdown.
 *
 * `text` always equals the source slice bounded by the exclusive offsets. A
 * repeated grant line is therefore a distinct authorization occurrence even
 * when its reference and text are identical to another line. Offsets are
 * zero-based UTF-16 code-unit positions, matching `String.prototype.indexOf`
 * and mdast source offsets. `offsetEnd` is exclusive and bounds the complete
 * physical line, including permitted leading and trailing whitespace rather
 * than a trimmed substring. Line numbers are one-based; under this module's
 * grant grammar, `endLine` always equals `startLine`.
 */
export interface SecretGrant {
  readonly ref: string;
  readonly text: string;
  readonly offsetStart: number;
  readonly offsetEnd: number;
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * Extracts explicit secret grants from a normalized test prompt.
 *
 * The CommonMark tree supplies absolute ranges for fenced, indented, and
 * inline code. A physical line is excluded when its half-open source range
 * overlaps one of those ranges, rather than only when one range contains the
 * other, because a partial boundary intersection must still make the whole
 * candidate non-authoritative. The visitor uses an explicit stack so deeply
 * nested untrusted Markdown cannot consume the JavaScript call stack; this
 * matches the bounded-input posture used for provider citations.
 *
 * CommonMark parsing is total for string input, so unlike a format parser
 * with invalid-source states this function has no fail-closed branch. The
 * branded input guarantees LF normalization before physical-line offsets are
 * computed, preventing a raw carriage return from silently changing a line's
 * matching or range boundary.
 *
 * @param normalizedTestMd - Canonical Markdown whose grant lines are being
 * inspected for secret authorization.
 * @returns Grants in source order, with raw source text and absolute offsets
 * preserved for deterministic attribution.
 */
export function extractSecretGrants(normalizedTestMd: NormalizedTestMd): readonly SecretGrant[] {
  const excludedRanges: Array<{ readonly start: number; readonly end: number }> = [];
  const nodes: MarkdownNode[] = [fromMarkdown(normalizedTestMd) as MarkdownNode];

  while (nodes.length > 0) {
    const node = nodes.pop();
    if (node === undefined) {
      continue;
    }

    if ((node.type === 'code' || node.type === 'inlineCode') && node.position !== undefined) {
      excludedRanges.push({
        start: node.position.start.offset,
        end: node.position.end.offset,
      });
    }

    if (node.children !== undefined) {
      for (const child of node.children) {
        nodes.push(child);
      }
    }
  }

  const grants: SecretGrant[] = [];
  let offsetStart = 0;

  for (const [index, line] of normalizedTestMd.split('\n').entries()) {
    const offsetEnd = offsetStart + line.length;
    const match = GRANT_LINE_PATTERN.exec(line);
    const overlapsExcludedRange = excludedRanges.some(({ start, end }) => (
      offsetStart < end && start < offsetEnd
    ));

    if (match !== null && !overlapsExcludedRange) {
      const ref = match[1];
      if (ref !== undefined) {
        grants.push({
          ref,
          text: normalizedTestMd.slice(offsetStart, offsetEnd),
          offsetStart,
          offsetEnd,
          startLine: index + 1,
          endLine: index + 1,
        });
      }
    }

    offsetStart = offsetEnd + 1;
  }

  return grants;
}
