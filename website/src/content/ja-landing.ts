import type { LandingCopy } from './en-landing.ts';
import { npmVersion } from '../data/site-meta.ts';

export const jaLanding = {
  hero: {
    eyebrow: 'CAST ONCE · REPLAY · 0 AI CALLS',
    title: 'プロンプトネイティブな E2E テスト。',
    summary: '一度鋳込み、意図をそのまま保つ。テストを Markdown プロンプトとして書き、プランを一度だけ生成し、決定的にリプレイする。キャッシュが命中する限り AI 呼び出しは 0 回。',
    primaryCta: 'はじめる',
    installCommand: 'npm install -D ambercast',
  },
  figureOne: {
    sourceNode: 'login.test.md',
    sourceCaption: 'プロンプト',
    generateLabel: 'generate',
    generateCallout: 'AI 呼び出し 1 回',
    castNode: 'cast',
    runLabel: 'run',
    runCallout: 'キャッシュ命中時は AI 呼び出し 0 回',
    replayNode: 'リプレイ ×N',
    healPill: '↑ UI ドリフト → heal · 影響を受けたステップだけを再解決・修復・再生成 · 書き込み前に確認',
    caption: 'FIG. 1 · CAST ONCE, REPLAY DETERMINISTICALLY',
  },
  commands: {
    eyebrow: 'NO. 002 · COMMANDS',
    heading: '3 つのコマンド。AI を呼ぶのはそのうち 1 つ。',
    rows: [
      { number: '01', command: 'ambercast generate', description: 'プロンプトを読み、プランとグラウンディングを素の JSON として書き出す。ロックファイルのようにレビューできる。', status: 'AI · 1 call' },
      { number: '02', command: 'ambercast run', description: 'プランを実ブラウザでリプレイする。キャッシュミス時はその 1 ステップだけ AI 補助にフォールバックし、--cache-only で AI なしの経路を強制できる。', status: 'REPLAY · 0 AI CALLS' },
      { number: '03', command: 'ambercast heal', description: 'UI がドリフトしたとき、影響を受けたステップだけを再解決・修復・再生成し、書き込み前に確認を求める。', status: 'AI · ASKS FIRST' },
    ],
  },
  prerequisites: {
    eyebrow: 'NO. 003 · PREREQUISITES',
    heading: 'エージェントは自前で用意する。',
    summary: 'ambercast は手元にあるコーディングエージェントを、あなた自身の認証情報で使う。鍵は一切管理しない。',
    entries: [
      { term: 'ランタイム', description: 'Node.js ≥ 22.14' },
      { term: 'ブラウザ', description: 'npx playwright-core install chromium。現時点では Chromium のみ。' },
      { term: 'エージェント', description: 'インストール・認証済みの claude または codex CLI。既定の ai.provider: "auto" は claude、次に codex の順に探す。' },
    ],
  },
  footer: { github: 'GitHub', npm: `npm v${npmVersion}`, changelog: 'Changelog', license: 'MIT', specimen: 'PRE-1.0 · CHROMIUM · LOCAL' },
  demo: { tryIt: '試してみる', generate: '生成 ›', run: '実行 ›', runAgain: 'もう一度実行 ›', reset: 'リセット' },
} satisfies LandingCopy;
