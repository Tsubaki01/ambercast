import { ExpressiveCodeTheme } from '@astrojs/starlight/expressive-code';

type ThemeType = 'dark' | 'light';

type ScopeRow = {
  scopes: string[];
  dark: string;
  light: string;
  fontStyle: 'bold' | '';
};

/*
 * The builder derives both monochrome themes from one ordered table so token precedence
 * remains reviewable. Explicit empty font styles are part of that contract: TextMate scopes can
 * inherit boldness, so a punctuation row must actively restore regular weight.
 *
 * Expressive Code accepts VS Code theme colors through `colors.editor.*`; its constructor derives
 * the public foreground and background fields from those keys, avoiding a second color mapping.
 */
const SCOPE_TABLE: ScopeRow[] = [
  {
    scopes: ['comment', 'punctuation.definition.comment'],
    dark: '#766B60',
    light: '#9E9184',
    fontStyle: '',
  },
  {
    scopes: [
      'keyword',
      'storage',
      'entity.name.function',
      'entity.name.command',
      'support.function',
      'support.type.property-name',
      'meta.object-literal.key',
      'entity.name.tag',
    ],
    dark: '#FAF6F0',
    light: '#181310',
    fontStyle: 'bold',
  },
  {
    scopes: ['string', 'constant.numeric', 'constant.language'],
    dark: '#F1EBE2',
    light: '#27211C',
    fontStyle: '',
  },
  {
    scopes: ['punctuation', 'meta.brace', 'keyword.operator'],
    dark: '#9E9184',
    light: '#766B60',
    fontStyle: '',
  },
];

/**
 * Keeps the VS Code theme input local so consumers cannot reorder scope precedence or mix variants.
 */
function buildTheme(type: ThemeType): ExpressiveCodeTheme {
  const dark = type === 'dark';
  return new ExpressiveCodeTheme({
    name: dark ? 'ambercast-dark' : 'ambercast-light',
    type,
    colors: {
      'editor.background': dark ? '#100C09' : '#F1EBE2',
      'editor.foreground': dark ? '#E2D9CC' : '#3B332C',
    },
    tokenColors: SCOPE_TABLE.map((row) => ({
      scope: row.scopes,
      settings: { foreground: row[type], fontStyle: row.fontStyle },
    })),
  });
}

/**
 * Expressive Code themes consumed by the Starlight configuration.
 *
 * The two-element tuple is ordered dark first and light second, with theme names
 * `ambercast-dark` and `ambercast-light` respectively. Starlight consumes this stable export
 * directly from `astro.config.mjs`.
 */
export const codeThemes = [buildTheme('dark'), buildTheme('light')] as const;
