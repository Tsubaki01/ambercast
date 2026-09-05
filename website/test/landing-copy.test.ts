import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { enLanding, type LandingCopy } from '../src/content/en-landing.ts';
import { jaLanding } from '../src/content/ja-landing.ts';
import { zhCnLanding } from '../src/content/zh-cn-landing.ts';
import { npmVersion } from '../src/data/site-meta.ts';

const rootPackageVersion: string = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
).version;

const jaCopy: LandingCopy = jaLanding;
const zhCnCopy: LandingCopy = zhCnLanding;
const localizedCopies = [jaCopy, zhCnCopy];

function stringLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringLeaves);
  return [];
}

describe('localized landing copy', () => {
  it('preserves English-only copy and command metadata', () => {
    for (const copy of localizedCopies) {
      assert.equal(copy.hero.eyebrow, enLanding.hero.eyebrow);
      assert.equal(copy.hero.installCommand, enLanding.hero.installCommand);
      assert.equal(copy.figureOne.sourceNode, enLanding.figureOne.sourceNode);
      assert.equal(copy.figureOne.generateLabel, enLanding.figureOne.generateLabel);
      assert.equal(copy.figureOne.castNode, enLanding.figureOne.castNode);
      assert.equal(copy.figureOne.runLabel, enLanding.figureOne.runLabel);
      assert.equal(copy.figureOne.caption, enLanding.figureOne.caption);
      assert.equal(copy.commands.eyebrow, enLanding.commands.eyebrow);
      assert.equal(copy.prerequisites.eyebrow, enLanding.prerequisites.eyebrow);
      assert.equal(copy.footer.github, enLanding.footer.github);
      assert.equal(copy.footer.changelog, enLanding.footer.changelog);
      assert.equal(copy.footer.license, enLanding.footer.license);
      assert.equal(copy.footer.specimen, enLanding.footer.specimen);

      for (const [index, row] of copy.commands.rows.entries()) {
        const englishRow = enLanding.commands.rows[index];
        assert.equal(row.number, englishRow.number);
        assert.equal(row.command, englishRow.command);
        assert.equal(row.status, englishRow.status);
        assert.ok(row.status.startsWith('AI') || row.status.startsWith('REPLAY'), `status "${row.status}" must keep its color-coding prefix in Latin script.`);
      }
    }
  });

  it('derives localized npm footer labels from the published package version', () => {
    assert.equal(npmVersion, rootPackageVersion);
    for (const copy of localizedCopies) assert.equal(copy.footer.npm, `npm v${rootPackageVersion}`);
  });

  it('keeps localized string leaves free of prohibited wording', () => {
    for (const copy of localizedCopies) {
      for (const leaf of stringLeaves(copy)) {
        assert.equal(/[!！]/.test(leaf), false);
        assert.equal(/\binit\b/i.test(leaf), false);
      }
    }
  });

  it('uses the approved localized demo labels', () => {
    assert.deepEqual(jaLanding.demo, {
      tryIt: '試してみる',
      generate: '生成 ›',
      run: '実行 ›',
      runAgain: 'もう一度実行 ›',
      reset: 'リセット',
    });
    assert.deepEqual(zhCnLanding.demo, {
      tryIt: '试一试',
      generate: '生成 ›',
      run: '运行 ›',
      runAgain: '再次运行 ›',
      reset: '重置',
    });
  });
});
