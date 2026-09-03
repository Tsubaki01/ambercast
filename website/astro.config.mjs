import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://tsubaki01.github.io',
  base: '/ambercast',
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
      favicon: '/favicon.svg',
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
