import { describe, expect, it } from 'vitest';
import { normalizeTestMd } from '#core/ir/normalize.js';
import { extractSecretGrants } from '#core/ir/secret-grant-source.js';

function grants(markdown: string) {
  return extractSecretGrants(normalizeTestMd(markdown));
}

function expectRawSlices(markdown: string): void {
  const normalized = normalizeTestMd(markdown);

  for (const grant of extractSecretGrants(normalized)) {
    expect(grant.text).toBe(normalized.slice(grant.offsetStart, grant.offsetEnd));
  }
}

describe('extractSecretGrants', () => {
  it.each([
    ['a tilde fence', '~~~markdown\n@ambercast-secret {{secrets.FENCED}}\n~~~\n'],
    ['a four-backtick fence', '````markdown\n@ambercast-secret {{secrets.FOUR_BACKTICKS}}\n````\n'],
    ['an indented code block', '    @ambercast-secret {{secrets.INDENTED}}\n'],
    ['an inline code span', 'Use `\n@ambercast-secret {{secrets.INLINE}}\n` as an example.\n'],
  ])('excludes a candidate inside %s', (_description, markdown) => {
    expect(grants(markdown)).toEqual([]);
  });

  it('includes a grant line in a list-item paragraph', () => {
    expect(grants('- Credentials:\n  @ambercast-secret {{secrets.LIST_ITEM}}\n')).toMatchObject([{
      ref: '{{secrets.LIST_ITEM}}',
      startLine: 2,
      endLine: 2,
    }]);
  });

  it('includes a grant line in a lazy paragraph continuation', () => {
    expect(grants('> Credentials follow:\n@ambercast-secret {{secrets.LAZY}}\n')).toMatchObject([{
      ref: '{{secrets.LAZY}}',
      startLine: 2,
      endLine: 2,
    }]);
  });

  it('allows leading and trailing horizontal whitespace while preserving the raw physical line', () => {
    const markdown = '  @ambercast-secret\t{{secrets.WHITESPACE}}  \t\n';

    expect(grants(markdown)).toEqual([{
      ref: '{{secrets.WHITESPACE}}',
      text: '  @ambercast-secret\t{{secrets.WHITESPACE}}  \t',
      offsetStart: 0,
      offsetEnd: markdown.length - 1,
      startLine: 1,
      endLine: 1,
    }]);
  });

  it.each([
    '@ambercast-secret {{secrets.TRAILING}} extra\n',
    '@ambercast-secret {{secrets.TRAILING}} # explanation\n',
    '@ambercast-secret {{secrets.TRAILING}}\u00a0\n',
  ])('rejects extra trailing content on a candidate grant line', (markdown) => {
    expect(grants(markdown)).toEqual([]);
  });

  it('keeps identical grant text at different offsets as distinct grants with raw slices', () => {
    const markdown = '@ambercast-secret {{secrets.REPEATED}}\n\n@ambercast-secret {{secrets.REPEATED}}\n';
    const extracted = grants(markdown);

    expect(extracted).toHaveLength(2);
    expect(extracted[0]).toMatchObject({ ref: '{{secrets.REPEATED}}', startLine: 1, endLine: 1 });
    expect(extracted[1]).toMatchObject({ ref: '{{secrets.REPEATED}}', startLine: 3, endLine: 3 });
    expect(extracted[0]?.offsetStart).not.toBe(extracted[1]?.offsetStart);
    expectRawSlices(markdown);
  });

  it('rejects a blockquote-prefixed candidate because the raw line is not grant grammar', () => {
    expect(grants('> @ambercast-secret {{secrets.BLOCKQUOTE}}\n')).toEqual([]);
  });

  it('accepts a grant on the first physical line', () => {
    expect(grants('@ambercast-secret {{secrets.FIRST}}\nPrompt body.\n')).toMatchObject([{
      ref: '{{secrets.FIRST}}',
      offsetStart: 0,
      startLine: 1,
      endLine: 1,
    }]);
  });

  it('accepts a grant directly after a closing fence without treating adjacent ranges as overlapping', () => {
    const markdown = '```\n@ambercast-secret {{secrets.EXAMPLE}}\n```\n@ambercast-secret {{secrets.BOUNDARY}}\n';

    expect(grants(markdown)).toMatchObject([{
      ref: '{{secrets.BOUNDARY}}',
      startLine: 4,
      endLine: 4,
    }]);
  });

  it('treats an HTML block candidate as prose rather than code', () => {
    expect(grants('<section>\n@ambercast-secret {{secrets.HTML}}\n</section>\n')).toMatchObject([{
      ref: '{{secrets.HTML}}',
      startLine: 2,
      endLine: 2,
    }]);
  });

  it('treats setext-heading text as prose rather than code', () => {
    expect(grants('@ambercast-secret {{secrets.SETEXT}}\n===============================\n')).toMatchObject([{
      ref: '{{secrets.SETEXT}}',
      startLine: 1,
      endLine: 1,
    }]);
  });

  it.each(['', '# Prompt\n\nThere are no secret grants here.\n'])('returns no grants for an empty or grant-free document', (markdown) => {
    expect(grants(markdown)).toEqual([]);
  });

  it('does not exhaust call arguments for a very wide Markdown tree', () => {
    const markdown = Array.from({ length: 150_000 }, () => 'Paragraph.').join('\n\n');

    expect(() => extractSecretGrants(normalizeTestMd(markdown))).not.toThrow();
  });
});
