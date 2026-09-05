import { describe, expect, it } from 'vitest';
import {
  classifyPromptLine,
  escapeHtml,
  formatPrerequisite,
  highlightJsonLine,
  splitHealNote,
} from '../src/scripts/landing-format.ts';
import { enLanding } from '../src/content/en-landing.ts';
import { jaLanding } from '../src/content/ja-landing.ts';
import { zhCnLanding } from '../src/content/zh-cn-landing.ts';
import { PLAN_LINES, browserUrlMarkup } from '../src/scripts/demo-markup.ts';

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

function decodeEntities(text: string): string {
  // Builders emit exactly these five entities, so this is a closed, non-DOM text oracle.
  expect(text).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#39;)/);
  return text.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

describe('escapeHtml', () => {
  it('escapes all five permitted entities in a stable order', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('does not claim idempotence for already escaped text', () => {
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });
});

describe('classifyPromptLine', () => {
  it.each([
    ['# Login', 'heading'], ['@ambercast-secret {{secrets.password}}', 'grant'], ['body', 'body'], ['', 'body'],
    ['#without-space', 'body'], ['@ambercast-secretary', 'grant'], ['@ambercast-secrets', 'grant'],
  ] as const)('classifies %j as %s', (line, expected) => {
    expect(classifyPromptLine(line)).toBe(expected);
  });
});

describe('splitHealNote', () => {
  it.each([
    ['en', 'lead · tail'], ['ja', '先頭 · 後半'], ['zh-cn', '前半 · 后半'], ['missing', 'only lead'],
    ['at zero', ' · tail'], ['repeated', 'lead · tail · again'], ['empty', ''],
  ])('preserves %s input exactly', (_label, text) => {
    const parts = splitHealNote(text);
    expect(parts.lead + parts.tail).toBe(text);
    if (text.includes(' · ')) {
      expect(parts.lead).not.toContain(' · ');
      expect(parts.tail.startsWith(' · ')).toBe(true);
    }
  });

  it('splits only the first delimiter and retains it in tail', () => {
    expect(splitHealNote('lead · tail · again')).toEqual({ lead: 'lead', tail: ' · tail · again' });
  });
});

describe('formatPrerequisite', () => {
  const cases = [
    ['en', 'Value. Note', { value: 'Value', separator: '. ', note: 'Note' }],
    ['ja', '値。注記', { value: '値', separator: '。', note: '注記' }],
    ['zh-cn', '值。说明', { value: '值', separator: '。', note: '说明' }],
    ['en', 'Value. ', { value: 'Value', separator: '. ', note: '' }],
    ['ja', '値。', { value: '値', separator: '。', note: '' }],
    ['en', '. Note', { value: '', separator: '. ', note: 'Note' }],
    ['en', 'No separator', { value: 'No separator', separator: '', note: '' }],
    ['en', '英文。句点', { value: '英文。句点', separator: '', note: '' }],
    ['ja', '日本語. note', { value: '日本語. note', separator: '', note: '' }],
  ] as const;

  it.each(cases)('%s uses only its approved separator', (locale, description, expected) => {
    const parts = formatPrerequisite(description, locale);
    expect(parts).toEqual(expected);
    expect(parts.value + parts.separator + parts.note).toBe(description);
  });

  it.each([
    ['en', enLanding], ['ja', jaLanding], ['zh-cn', zhCnLanding],
  ] as const)('preserves every approved %s prerequisite entry', (locale, copy) => {
    for (const entry of copy.prerequisites.entries) {
      const parts = formatPrerequisite(entry.description, locale);
      expect(parts.value + parts.separator + parts.note).toBe(entry.description);
    }
  });
});

describe('highlightJsonLine', () => {
  it('renders the specification example verbatim', () => {
    expect(highlightJsonLine('  "id": "open-login", "n": 2, "ok": true')).toBe(
      '  <span class="demo-json-key">&quot;id&quot;</span>: <span class="demo-json-value">&quot;open-login&quot;</span>, <span class="demo-json-key">&quot;n&quot;</span>: <span class="demo-json-value">2</span>, <span class="demo-json-key">&quot;ok&quot;</span>: <span class="demo-json-value">true</span>',
    );
  });

  it.each([
    [' "a b" : "x\\\"y" ', String.raw` <span class="demo-json-key">&quot;a b&quot;</span> : <span class="demo-json-value">&quot;x\&quot;y&quot;</span> `],
    ['"even\\\\\\\"quote": 1', String.raw`<span class="demo-json-key">&quot;even\\\&quot;quote&quot;</span>: <span class="demo-json-value">1</span>`],
    ['"odd\\\\\"quote": 1', String.raw`<span class="demo-json-value">&quot;odd\\&quot;</span>quote<span class="demo-json-value">&quot;: 1</span>`],
    ['"trailing\\', String.raw`<span class="demo-json-value">&quot;trailing\</span>`], ['"unterminated', '<span class="demo-json-value">&quot;unterminated</span>'],
    ['01', '<span class="demo-json-value">01</span>'],
    ['-1.25E+3', '<span class="demo-json-value">-1.25E+3</span>'],
    ['1.', '<span class="demo-json-value">1</span>.'],
    ['1e+', '<span class="demo-json-value">1</span>e+'],
    ['true,false,null truex xfalse 0true', '<span class="demo-json-value">true</span>,<span class="demo-json-value">false</span>,<span class="demo-json-value">null</span> truex xfalse <span class="demo-json-value">0</span>true'],
    ['"<script>&\\\"\\\'"', String.raw`<span class="demo-json-value">&quot;&lt;script&gt;&amp;\&quot;\&#39;&quot;</span>`],
  ])('renders %j with its exact token boundaries', (input, expected) => {
    const html = highlightJsonLine(input);
    expect(html).toBe(expected);
    expect(html).not.toContain('<script>');
  });

  it('escapes every approved displayed plan line without allowing markup through', () => {
    for (const line of PLAN_LINES) {
      const html = highlightJsonLine(line.text);
      const textOnly = html
        .replaceAll('<span class="demo-json-key">', '')
        .replaceAll('<span class="demo-json-value">', '')
        .replaceAll('</span>', '');
      expect(textOnly).not.toContain('<');
      expect(decodeEntities(stripTags(html))).toBe(line.text);
    }
  });
});

describe('browserUrlMarkup', () => {
  it('escapes an untrusted URL path before the HTML sink', () => {
    const path = '/login?<img src=x onerror=alert(1)>&"\'';
    expect(browserUrlMarkup(path)).toBe('<div class="demo-browser-url"><span class="demo-browser-dots"><i></i><i></i><i></i></span><span>localhost:3000/login?&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;</span></div>');
  });

  it('renders an ordinary path exactly once in the URL strip', () => {
    expect(browserUrlMarkup('/dashboard')).toBe('<div class="demo-browser-url"><span class="demo-browser-dots"><i></i><i></i><i></i></span><span>localhost:3000/dashboard</span></div>');
  });
});
