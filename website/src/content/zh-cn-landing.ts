import type { LandingCopy } from './en-landing.ts';
import { npmVersion } from '../data/site-meta.ts';

export const zhCnLanding = {
  hero: {
    eyebrow: 'CAST ONCE · REPLAY · 0 AI CALLS',
    title: '提示词原生的 E2E 测试。',
    summary: '铸造一次，意图完整保留。用 Markdown 提示词编写测试，只生成一次执行计划，然后确定性地回放：只要缓存命中，AI 调用为 0。',
    primaryCta: '快速开始',
    installCommand: 'npm install -D ambercast',
  },
  figureOne: {
    sourceNode: 'login.test.md',
    sourceCaption: '提示词',
    generateLabel: 'generate',
    generateCallout: '1 次 AI 调用',
    castNode: 'cast',
    runLabel: 'run',
    runCallout: '缓存命中时 0 次 AI 调用',
    replayNode: '回放 ×N',
    healPill: '↑ UI 漂移 → heal · 只重新解析、修复或重新生成受影响的步骤 · 写入前先确认',
    caption: 'FIG. 1 · CAST ONCE, REPLAY DETERMINISTICALLY',
  },
  commands: {
    eyebrow: 'NO. 002 · COMMANDS',
    heading: '三个命令。只有一个会调用 AI。',
    rows: [
      { number: '01', command: 'ambercast generate', description: '读取提示词，把执行计划和定位缓存写成纯 JSON。像锁文件一样复核它们。', status: 'AI · 1 call' },
      { number: '02', command: 'ambercast run', description: '在真实浏览器中回放执行计划。缓存未命中时仅对该步骤回退为 AI 辅助；--cache-only 可强制无 AI 路径。', status: 'REPLAY · 0 AI CALLS' },
      { number: '03', command: 'ambercast heal', description: '当 UI 发生漂移时，只重新解析、修复或重新生成受影响的步骤，并在写入前请求确认。', status: 'AI · ASKS FIRST' },
    ],
  },
  prerequisites: {
    eyebrow: 'NO. 003 · PREREQUISITES',
    heading: '自带你的编码代理。',
    summary: 'ambercast 使用你已有的编码代理和你自己的凭据，自身不管理任何密钥。',
    entries: [
      { term: '运行时', description: 'Node.js ≥ 22.14' },
      { term: '浏览器', description: 'npx playwright-core install chromium。目前仅支持 Chromium。' },
      { term: '代理', description: '已安装并完成身份验证的 claude 或 codex CLI。默认 ai.provider: "auto" 先查找 claude，再查找 codex。' },
    ],
  },
  footer: { github: 'GitHub', npm: `npm v${npmVersion}`, changelog: 'Changelog', license: 'MIT', specimen: 'PRE-1.0 · CHROMIUM · LOCAL' },
  demo: { tryIt: '试一试', generate: '生成 ›', run: '运行 ›', runAgain: '再次运行 ›', reset: '重置' },
} satisfies LandingCopy;
