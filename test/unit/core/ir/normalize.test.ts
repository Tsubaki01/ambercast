import { describe, expect, it } from 'vitest';
import { normalizeTestMd } from '../../../../src/core/ir/normalize.js';

describe('normalizeTestMd', () => {
  it('leaves already-LF Markdown unchanged and returns a runtime string', () => {
    const raw = '# Sign in\n\nOpen the dashboard.\n';
    const normalized = normalizeTestMd(raw);

    expect(normalized).toBe(raw);
    expect(typeof normalized).toBe('string');
    expect(`${normalized}`).toBe(raw);
  });

  it.each([
    ['an empty string', '', ''],
    ['only a byte-order mark', '\uFEFF', ''],
    ['only a lone carriage return', '\r', '\n'],
    ['two leading byte-order marks', '\uFEFF\uFEFF', '\uFEFF'],
  ])('normalizes %s', (_description, raw, expected) => {
    expect(normalizeTestMd(raw)).toBe(expected);
  });

  it('converts mixed CRLF and lone CR line endings', () => {
    expect(normalizeTestMd('first\r\nsecond\rthird\nfourth')).toBe('first\nsecond\nthird\nfourth');
  });

  it('removes a leading byte-order mark before converting an immediate CRLF', () => {
    expect(normalizeTestMd('\uFEFF\r\n# Heading')).toBe('\n# Heading');
  });

  it('preserves internal whitespace, blank lines, and trailing line whitespace', () => {
    const raw = '  # Heading  \r\n\r\n \tBody with spaces  \r  ';

    expect(normalizeTestMd(raw)).toBe('  # Heading  \n\n \tBody with spaces  \n  ');
  });
});
