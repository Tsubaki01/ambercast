import starlight from '@astrojs/starlight';
import { ExpressiveCodeTheme } from '@astrojs/starlight/expressive-code';
import { defineConfig } from 'astro/config';
import { codeThemes } from './src/styles/code-themes';

const site = 'https://kotarotsubaki.github.io';
const base = '/ambercast';
const assetUrl = (asset) => new URL(`${base}/${asset}`, site).href;

export default defineConfig({
  site,
  base,
  integrations: [
    starlight({
      title: 'ambercast',
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        ja: { label: '日本語', lang: 'ja' },
        'zh-cn': { label: '简体中文', lang: 'zh-CN' },
      },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/kotarotsubaki/ambercast' }],
      editLink: {
        baseUrl: 'https://github.com/kotarotsubaki/ambercast/edit/main/website/',
      },
      lastUpdated: false,
      favicon: assetUrl('favicon.svg'),
      head: [
        { tag: 'link', attrs: { rel: 'icon', href: assetUrl('favicon.svg'), type: 'image/svg+xml' } },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: assetUrl('apple-touch-icon.png'), sizes: '180x180' } },
        { tag: 'meta', attrs: { property: 'og:image', content: assetUrl('og-image.png') } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: assetUrl('og-image.png') } },
      ],
      customCss: ['./src/styles/custom.css'],
      components: {
        SiteTitle: './src/components/SiteTitle.astro',
        Header: './src/components/Header.astro',
        Sidebar: './src/components/Sidebar.astro',
        PageTitle: './src/components/PageTitle.astro',
        TableOfContents: './src/components/TableOfContents.astro',
        Pagination: './src/components/Pagination.astro',
        Footer: './src/components/Footer.astro',
      },
      // The monochrome pair owns token colors while Starlight keeps its UI surfaces in sync
      // with site tokens. Contrast normalization stays disabled because it would mutate the approved
      // low-emphasis token colors instead of preserving the explicit theme table.
      expressiveCode: {
        // Starlight forwards custom values unchanged, while Expressive Code operates on theme
        // instances. Convert the dependency-free definitions only where that dependency exists.
        themes: codeThemes.map((theme) => new ExpressiveCodeTheme(theme)),
        useStarlightUiThemeColors: true,
        minSyntaxHighlightingColorContrast: 0,
        // Starlight's UI-color pass precedes this callback. It restores
        // only frame backgrounds so code surfaces remain tied to the CSS token without replacing the
        // generated marker and accessibility colors. Frame overrides are optional when the UI-color
        // pass is disabled, so the callback creates that nested map before preserving this invariant.
        customizeTheme(theme) {
          theme.styleOverrides.frames ??= {};
          theme.styleOverrides.frames.editorBackground = 'var(--ac-code-bg)';
          theme.styleOverrides.frames.terminalBackground = 'var(--ac-code-bg)';
          return theme;
        },
        styleOverrides: {
          borderRadius: '10px',
          borderColor: 'var(--sl-color-hairline)',
          codeBackground: 'var(--ac-code-bg)',
          codeFontFamily: 'var(--sl-font-mono)',
          codeFontSize: 'var(--sl-text-code)',
          codeLineHeight: '1.7',
          frames: {
            editorTabBarBackground: 'var(--ac-code-bg)',
            editorActiveTabBackground: 'var(--ac-code-bg)',
            editorActiveTabIndicatorTopColor: 'transparent',
            editorTabBarBorderBottomColor: 'var(--sl-color-hairline)',
            terminalTitlebarBackground: 'var(--ac-code-bg)',
            terminalTitlebarDotsForeground: 'transparent',
            terminalTitlebarBorderBottomColor: 'var(--sl-color-hairline)',
            terminalBackground: 'var(--ac-code-bg)',
            shadowColor: 'transparent',
            frameBoxShadowCssValue: 'none',
            copyButtonBackground: 'var(--ac-code-bg)',
            copyButtonBorderColor: 'var(--sl-color-hairline)',
          },
          textMarkers: {
            markBackground: 'var(--sl-color-gray-6)',
            markBorderColor: 'var(--sl-color-gray-3)',
            insBackground: 'var(--sl-color-green-low)',
            insBorderColor: 'var(--sl-color-green)',
            delBackground: 'var(--sl-color-red-low)',
            delBorderColor: 'var(--sl-color-red)',
          },
        },
      },
      sidebar: [
        {
          label: 'Guides',
          items: [{ autogenerate: { directory: 'guides' } }],
        },
        {
          label: 'Reference',
          items: [{ autogenerate: { directory: 'reference' } }],
        },
      ],
    }),
  ],
});
