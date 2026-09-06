import { describe, expect, it } from 'vitest';
import { codeThemes } from '../src/styles/code-themes.ts';

const EXPECTED_ROWS = [
  { scope: ['comment', 'punctuation.definition.comment'], settings: { dark: '#766b60', light: '#9e9184', fontStyle: '' } },
  { scope: ['keyword', 'storage', 'entity.name.function', 'entity.name.command', 'support.function', 'support.type.property-name', 'meta.object-literal.key', 'entity.name.tag'], settings: { dark: '#faf6f0', light: '#181310', fontStyle: 'bold' } },
  { scope: ['string', 'constant.numeric', 'constant.language'], settings: { dark: '#f1ebe2', light: '#27211c', fontStyle: '' } },
  { scope: ['punctuation', 'meta.brace', 'keyword.operator'], settings: { dark: '#9e9184', light: '#766b60', fontStyle: '' } },
] as const;

describe('codeThemes', () => {
  it('exports the dark and light monochrome themes in the required stable order', () => {
    const themes = codeThemes as unknown as Array<{
      type: string;
      name: string;
      colors: Record<string, string>;
    }>;
    expect(themes).toHaveLength(2);
    const [dark, light] = themes;
    expect(dark.type).toBe('dark'); expect(light.type).toBe('light');
    expect(dark.name).toBe('ambercast-dark'); expect(light.name).toBe('ambercast-light');
    expect(dark.colors['editor.background'].toLowerCase()).toBe('#100c09'); expect(light.colors['editor.background'].toLowerCase()).toBe('#f1ebe2');
    expect(dark.colors['editor.foreground'].toLowerCase()).toBe('#e2d9cc'); expect(light.colors['editor.foreground'].toLowerCase()).toBe('#3b332c');
  });

  it('preserves the complete ordered scope table without implicit regular-weight inheritance', () => {
    const themes = codeThemes as unknown as Array<{ tokenColors: Array<{ scope: string[]; settings: { foreground?: string; fontStyle?: string } }> }>;
    const [dark, light] = themes;
    const rows = (theme: (typeof themes)[number]) => theme.tokenColors.map((entry) => ({
      scope: entry.scope,
      settings: { foreground: entry.settings.foreground?.toLowerCase(), fontStyle: entry.settings.fontStyle },
    }));
    expect(rows(dark)).toEqual(EXPECTED_ROWS.map(({ scope, settings }) => ({ scope, settings: { foreground: settings.dark, fontStyle: settings.fontStyle } })));
    expect(rows(light)).toEqual(EXPECTED_ROWS.map(({ scope, settings }) => ({ scope, settings: { foreground: settings.light, fontStyle: settings.fontStyle } })));
    expect(dark.tokenColors).toHaveLength(4); expect(light.tokenColors).toHaveLength(4);
    expect(dark.tokenColors.map((entry) => entry.scope)).toEqual(light.tokenColors.map((entry) => entry.scope));
    for (const theme of themes) for (const row of theme.tokenColors.filter((entry) => entry.settings.fontStyle !== 'bold')) expect(row.settings.fontStyle).toBe('');
  });
});
