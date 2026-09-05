import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

const site = 'https://tsubaki01.github.io';
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
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/Tsubaki01/ambercast' }],
      editLink: {
        baseUrl: 'https://github.com/Tsubaki01/ambercast/edit/main/website/',
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
      // A monochrome pair leaves visible code colors to the design token overrides below.
      expressiveCode: {
        themes: ['github-dark', 'github-light'],
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
          translations: { ja: 'ガイド', 'zh-CN': '指南' },
          items: [{ autogenerate: { directory: 'guides' } }],
        },
        {
          label: 'Reference',
          translations: { ja: 'リファレンス', 'zh-CN': '参考' },
          items: [{ autogenerate: { directory: 'reference' } }],
        },
      ],
    }),
  ],
});
