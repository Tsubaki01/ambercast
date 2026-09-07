#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEBSITE_DIRECTORY = resolve(HERE, '../..');
const SCREENSHOT_DIRECTORY = resolve(HERE, '.artifacts');
const HOST = '127.0.0.1';
let port = 4321;
let origin = `http://${HOST}:${port}`;
const BASE_PATH = '/ambercast/';
const STARTUP_TIMEOUT_MS = 15_000;
const INTERACTION_TIMEOUT_MS = 8_000;
const TYPING_TIMEOUT_MS = 2_000;
const KEYBOARD_ACTIVATION_KEYS = ['Enter', 'Space'];
const LIVE_REGION_ROLES = ['alert', 'log', 'marquee', 'status', 'timer'];
const LOCALE_ROOTS = [
  { path: '/', lang: 'en' },
  { path: '/ja/', lang: 'ja' },
  { path: '/zh-cn/', lang: 'zh-CN' },
];
const LOCALE_DEMO_LABELS = {
  '/': { tryIt: 'Try it', generate: 'Generate ›', run: 'Run ›', runAgain: 'Run again ›', reset: 'Reset' },
  '/ja/': { tryIt: '試してみる', generate: '生成 ›', run: '実行 ›', runAgain: 'もう一度実行 ›', reset: 'リセット' },
  '/zh-cn/': { tryIt: '试一试', generate: '生成 ›', run: '运行 ›', runAgain: '再次运行 ›', reset: '重置' },
};
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;

const APPROVED_EXTERNAL_SITE_URLS = [
  { origin: 'https://kotarotsubaki.github.io', pathnamePrefix: '/ambercast/' },
];

const APPROVED_EXTERNAL_ANCHOR_URLS = [
  ...APPROVED_EXTERNAL_SITE_URLS,
  { origin: 'https://playwright.dev', pathname: '/' },
  { origin: 'https://docs.claude.com', pathname: '/en/docs/claude-code' },
  { origin: 'https://github.com', pathname: '/openai/codex' },
  { origin: 'https://github.com', pathname: '/kotarotsubaki/ambercast' },
  { origin: 'https://github.com', pathname: '/kotarotsubaki/ambercast/blob/main/CHANGELOG.md' },
  { origin: 'https://github.com', pathnamePrefix: '/kotarotsubaki/ambercast/edit/main/website/' },
  { origin: 'https://www.npmjs.com', pathname: '/package/ambercast' },
];

const SCREENSHOTS = [
  { name: 'landing-1440-dark', path: '/', viewport: { width: 1440, height: 1100 }, colorScheme: 'dark' },
  { name: 'landing-1440-light', path: '/', viewport: { width: 1440, height: 1100 }, colorScheme: 'light' },
  { name: 'landing-390-dark', path: '/', viewport: { width: 390, height: 844 }, colorScheme: 'dark' },
  { name: 'landing-390-light', path: '/', viewport: { width: 390, height: 844 }, colorScheme: 'light' },
  { name: 'landing-1440-dark-ja', path: '/ja/', viewport: { width: 1440, height: 1100 }, colorScheme: 'dark' },
  { name: 'landing-1440-light-ja', path: '/ja/', viewport: { width: 1440, height: 1100 }, colorScheme: 'light' },
  { name: 'landing-390-dark-ja', path: '/ja/', viewport: { width: 390, height: 844 }, colorScheme: 'dark' },
  { name: 'landing-390-light-ja', path: '/ja/', viewport: { width: 390, height: 844 }, colorScheme: 'light' },
  { name: 'landing-1440-dark-zh-cn', path: '/zh-cn/', viewport: { width: 1440, height: 1100 }, colorScheme: 'dark' },
  { name: 'landing-1440-light-zh-cn', path: '/zh-cn/', viewport: { width: 1440, height: 1100 }, colorScheme: 'light' },
  { name: 'landing-390-dark-zh-cn', path: '/zh-cn/', viewport: { width: 390, height: 844 }, colorScheme: 'dark' },
  { name: 'landing-390-light-zh-cn', path: '/zh-cn/', viewport: { width: 390, height: 844 }, colorScheme: 'light' },
  { name: 'guide-dark', path: '/guides/getting-started/', viewport: { width: 1440, height: 1100 }, colorScheme: 'dark' },
  { name: 'guide-light', path: '/guides/getting-started/', viewport: { width: 1440, height: 1100 }, colorScheme: 'light' },
  { name: 'guide-ja', path: '/ja/guides/getting-started/', viewport: { width: 1440, height: 1100 }, colorScheme: 'dark' },
  { name: 'reference-dark', path: '/reference/cli/', viewport: { width: 1440, height: 1100 }, colorScheme: 'dark' },
  { name: 'reference-light', path: '/reference/cli/', viewport: { width: 1440, height: 1100 }, colorScheme: 'light' },
  { name: 'guide-390-dark', path: '/guides/getting-started/', viewport: { width: 390, height: 844 }, colorScheme: 'dark' },
  { name: 'guide-390-light', path: '/guides/getting-started/', viewport: { width: 390, height: 844 }, colorScheme: 'light' },
  { name: 'guide-zh-cn-dark', path: '/zh-cn/guides/getting-started/', viewport: { width: 1440, height: 1100 }, colorScheme: 'dark' },
  { name: 'reference-390-dark', path: '/reference/cli/', viewport: { width: 390, height: 844 }, colorScheme: 'dark' },
  { name: 'introduction-ja-1440-dark', path: '/ja/guides/introduction/', viewport: { width: 1440, height: 1100 }, colorScheme: 'dark' },
  { name: 'introduction-ja-2000-dark', path: '/ja/guides/introduction/', viewport: { width: 2000, height: 1100 }, colorScheme: 'dark' },
  { name: 'guide-ja-1440-light', path: '/ja/guides/getting-started/', viewport: { width: 1440, height: 1100 }, colorScheme: 'light' },
  { name: 'guide-ja-390-dark', path: '/ja/guides/getting-started/', viewport: { width: 390, height: 844 }, colorScheme: 'dark' },
  { name: 'guide-ja-390-light', path: '/ja/guides/getting-started/', viewport: { width: 390, height: 844 }, colorScheme: 'light' },
  { name: 'guide-zh-cn-1440-light', path: '/zh-cn/guides/getting-started/', viewport: { width: 1440, height: 1100 }, colorScheme: 'light' },
  { name: 'guide-zh-cn-390-dark', path: '/zh-cn/guides/getting-started/', viewport: { width: 390, height: 844 }, colorScheme: 'dark' },
  { name: 'guide-zh-cn-390-light', path: '/zh-cn/guides/getting-started/', viewport: { width: 390, height: 844 }, colorScheme: 'light' },
  { name: 'reference-ja-1440-dark', path: '/ja/reference/cli/', viewport: { width: 1440, height: 1100 }, colorScheme: 'dark' },
  { name: 'reference-ja-1440-light', path: '/ja/reference/cli/', viewport: { width: 1440, height: 1100 }, colorScheme: 'light' },
  { name: 'reference-ja-390-dark', path: '/ja/reference/cli/', viewport: { width: 390, height: 844 }, colorScheme: 'dark' },
  { name: 'reference-ja-390-light', path: '/ja/reference/cli/', viewport: { width: 390, height: 844 }, colorScheme: 'light' },
  { name: 'reference-390-light', path: '/reference/cli/', viewport: { width: 390, height: 844 }, colorScheme: 'light' },
  { name: 'introduction-en-1440-dark', path: '/guides/introduction/', viewport: { width: 1440, height: 1100 }, colorScheme: 'dark' },
  { name: 'introduction-en-2000-dark', path: '/guides/introduction/', viewport: { width: 2000, height: 1100 }, colorScheme: 'dark' },
  { name: 'introduction-en-1151-dark', path: '/guides/introduction/', viewport: { width: 1151, height: 1100 }, colorScheme: 'dark' },
  { name: 'introduction-en-1152-dark', path: '/guides/introduction/', viewport: { width: 1152, height: 1100 }, colorScheme: 'dark' },
  { name: 'introduction-ja-1151-dark', path: '/ja/guides/introduction/', viewport: { width: 1151, height: 1100 }, colorScheme: 'dark' },
  { name: 'introduction-ja-1152-dark', path: '/ja/guides/introduction/', viewport: { width: 1152, height: 1100 }, colorScheme: 'dark' },
];

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function findAvailablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not reserve a loopback port for the Astro preview.'));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

function startPreview() {
  let output = '';
  let startError;
  const child = spawn('npm', ['run', 'preview', '--', '--host', HOST, '--port', String(port)], {
    cwd: WEBSITE_DIRECTORY,
    detached: process.platform !== 'win32',
    // Astro backgrounds preview servers when it detects an agent. The test owns this child
    // and must await its shutdown, so the documented background marker suppresses only that
    // automatic detection while retaining the server's normal lifecycle.
    env: { ...process.env, ASTRO_PREVIEW_BACKGROUND: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk) => {
    output += chunk.toString();
  };

  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('error', (error) => {
    startError = error;
  });

  return { child, output: () => output, startError: () => startError };
}

async function waitForPreview(preview) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (preview.startError() !== undefined) throw preview.startError();

    if (preview.child.exitCode !== null) {
      throw new Error(`Astro preview exited before becoming ready.\n${preview.output()}`);
    }

    try {
      const response = await fetch(`${origin}${BASE_PATH}`, {
        signal: AbortSignal.timeout(500),
      });

      if (response.ok) return;
    } catch {
      // The server has not bound its listener yet.
    }

    await sleep(100);
  }

  throw new Error(`Astro preview did not become ready within ${STARTUP_TIMEOUT_MS}ms.\n${preview.output()}`);
}

async function stopPreview(preview) {
  const { child } = preview;

  if (child.exitCode !== null || child.signalCode !== null) return;

  const closed = once(child, 'close');

  try {
    if (process.platform === 'win32') {
      child.kill('SIGTERM');
    } else if (child.pid !== undefined) {
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }

  await Promise.race([closed, sleep(5_000)]);

  if (child.exitCode === null && process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }

  if (child.exitCode === null) await Promise.race([closed, sleep(5_000)]);
}

function pageUrl(path) {
  return new URL(path.replace(/^\//, ''), `${origin}${BASE_PATH}`).href;
}

async function waitForText(locator, pattern, message) {
  const deadline = Date.now() + INTERACTION_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const text = await locator.textContent();
    if (pattern.test(text ?? '')) return;
    await sleep(50);
  }

  throw new Error(message);
}

async function waitForFonts(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (const font of document.fonts) await font.load();
  });
}

function isApprovedExternalUrl(url, approvedUrls) {
  return approvedUrls.some(({ origin, pathname, pathnamePrefix }) => (
    url.origin === origin
    && (url.pathname === pathname || (pathnamePrefix !== undefined && url.pathname.startsWith(pathnamePrefix)))
  ));
}

async function assertBasePath(page) {
  const references = await page.locator('a[href], link[href], img[src], script[src]').evaluateAll((elements) => elements.map((element) => ({
    attribute: element.hasAttribute('href') ? 'href' : 'src',
    tagName: element.tagName.toLowerCase(),
    value: element.getAttribute(element.hasAttribute('href') ? 'href' : 'src'),
  })));

  for (const { attribute, tagName, value } of references) {
    if (!value || value.startsWith('#') || value.startsWith('data:') || value.startsWith('mailto:') || value.startsWith('tel:')) {
      continue;
    }

    const url = new URL(value, page.url());

    if (url.origin === origin) {
      assert.ok(url.pathname.startsWith(BASE_PATH), `${attribute} must retain the /ambercast/ base path: ${value}`);
    } else if (tagName === 'a') {
      assert.ok(isApprovedExternalUrl(url, APPROVED_EXTERNAL_ANCHOR_URLS), `anchor must use an approved external URL: ${value}`);
    } else {
      assert.ok(isApprovedExternalUrl(url, APPROVED_EXTERNAL_SITE_URLS), `${tagName} ${attribute} must use an approved site URL: ${value}`);
    }
  }
}

async function assertAssetsPresent() {
  const assets = [
    ['favicon.svg', 'image/svg+xml'],
    ['apple-touch-icon.png', 'image/png'],
    ['og-image.png', 'image/png'],
  ];

  for (const [asset, contentType] of assets) {
    const response = await fetch(`${origin}${BASE_PATH}${asset}`);

    assert.ok(response.ok, `${asset} must be served from the base path.`);
    assert.equal(response.headers.get('content-type')?.split(';', 1)[0], contentType);
  }
}

async function assertServerRenderedFallback() {
  const response = await fetch(pageUrl('/'));
  assert.ok(response.ok, 'The landing page must serve its fallback markup.');
  const html = await response.text();
  const generateTag = html.match(/<button\b[^>]*id="demo-generate"[^>]*>/)?.[0];
  const runTag = html.match(/<button\b[^>]*id="demo-run"[^>]*>/)?.[0];
  const resetTag = html.match(/<button\b[^>]*id="demo-reset"[^>]*>/)?.[0];

  assert.match(html, /id="demo-counter"[^>]*>RUNS 1 · AI CALLS 1</);
  assert.match(html, /Welcome, Mika/);
  assert.match(html, /id="demo-status"[^>]*aria-live="polite"[^>]*>NO\. 001 · LOGIN · 6\/6 STEPS · 2\.4S · 0 AI CALLS · EXIT 0</);
  assert.match(html, /login\.ambercast\.plan\.json/);
  assert.match(html, /demo-prompt-line/, 'SSR must use the shared prompt builder.');
  assert.match(html, /demo-json-key/, 'SSR must use the shared JSON highlighter.');
  assert.match(html, /data-plan-step="0"/, 'SSR must retain plan-step markers.');
  assert.match(html, /id="ambercast-demo"[^>]*data-demo-lit="browser"/, 'SSR done state must light the browser exhibit.');
  assert.ok(generateTag, 'The server-rendered Generate button must exist.');
  assert.match(generateTag, /\sdisabled(?:\s|>)/, 'Generate must be disabled in the fallback done state.');
  assert.ok(runTag, 'The server-rendered Run button must exist.');
  assert.match(runTag, /\sdisabled(?:\s|>)/, 'Run again must be disabled in the fallback done state until the adapter attaches.');
  assert.ok(resetTag, 'The server-rendered Reset button must exist.');
  assert.match(resetTag, /\sdisabled(?:\s|>)/, 'Reset must be disabled in the fallback done state until the adapter attaches.');
}

function rgbChannels(color) {
  const values = color.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number);
  assert.equal(values?.length, 3, `expected an rgb color, received ${color}`);
  return values;
}

function contrastRatio(foreground, background) {
  const linear = (channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (color) => {
    const [r, g, b] = rgbChannels(color);
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  };
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

async function assertComputedStyleTable(browser) {
  const context = await browser.newContext({ colorScheme: 'dark', reducedMotion: 'reduce', viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl('/'), { waitUntil: 'networkidle' });
    await waitForFonts(page);
    const { generate, status } = demoControls(page);
    await generate.click();
    await waitForText(status, /cast/i, 'Reduced-motion Generate must render the plan before computed-style assertions.');
    const computed = await page.evaluate(() => {
      const value = (selector, pseudo) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`Missing ${selector}`);
        const style = getComputedStyle(element, pseudo);
        return { color: style.color, backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage, borderColor: style.borderColor, borderBottomColor: style.borderBottomColor, borderBottomStyle: style.borderBottomStyle, boxShadow: style.boxShadow, display: style.display, height: style.height, width: style.width, maxWidth: style.maxWidth, top: style.top, left: style.left, right: style.right, zIndex: style.zIndex, pointerEvents: style.pointerEvents, overflow: style.overflow, isolation: style.isolation, transitionDuration: style.transitionDuration, padding: style.padding, minHeight: style.minHeight, marginTop: style.marginTop, gridTemplateColumns: style.gridTemplateColumns, gap: style.gap, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, whiteSpace: style.whiteSpace, letterSpacing: style.letterSpacing, borderTopStyle: style.borderTopStyle, cursor: style.cursor, opacity: style.opacity, filter: style.filter, backdropFilter: style.backdropFilter, gridColumn: style.gridColumn, borderRadius: style.borderRadius };
      };
      return {
        body: value('body'), header: value('header.header'), hero: value('.landing-hero'), heroGlow: value('.landing-hero', '::before'), mark: value('.landing-mark'),
        figureGlow: value('[data-exhibit="figure"]', '::before'), planGlow: value('[data-exhibit="plan"]', '::before'), browserGlow: value('[data-exhibit="browser"]', '::before'),
        panel: value('.demo-panel'), litPanel: value('[data-exhibit="plan"] .demo-panel'), panelHeader: value('.demo-panel > header'), panelFooter: value('.demo-panel > footer'), panelPre: value('#demo-prompt-panel pre'), planPre: value('#demo-plan-panel pre'), pill: value('.demo-pill'), pillDot: value('.demo-pill', '::before'),
        stage: value('.demo-stage'), button: value('.demo-action'), browser: value('.demo-browser'),
        justifySelf: getComputedStyle(document.querySelector('.demo-action')).justifySelf,
        actionGaps: ['#demo-generate', '#demo-run'].map((buttonSelector) => {
          const button = document.querySelector(buttonSelector).getBoundingClientRect();
          const panels = buttonSelector === '#demo-generate'
            ? ['#demo-prompt-panel', '#demo-plan-panel']
            : ['#demo-plan-panel', '#demo-browser-panel'];
          const [leftPanel, rightPanel] = panels.map((selector) => document.querySelector(selector).getBoundingClientRect());
          return { left: button.left - leftPanel.right, right: rightPanel.left - button.right };
        }),
        ledger: value('.landing-ledger'), ledgerRow: value('.landing-ledger-row'), ledgerLastRow: value('.landing-ledger-row:last-child'), ledgerNumber: value('.landing-ledger-row > span'), ledgerCommand: value('.landing-ledger-row code'), ledgerDescription: value('.landing-ledger-row p'), ledgerPill: value('.landing-ledger-row b'), prereq: value('.landing-prerequisites dl'), prereqCell: value('.landing-prerequisites dd'), prereqLabel: value('.landing-prerequisites dt'), prereqValue: value('.landing-prereq-value'), prereqNote: value('.landing-prereq-note'), section: value('.landing-section'), sectionWash: value('.landing-section', '::before'), prompt: value('.demo-prompt-body'), promptHeading: value('.demo-prompt-heading'), promptGrant: value('.demo-prompt-grant'),
        key: value('.demo-json-key'), jsonValue: value('.demo-json-value'), arrow: value('.landing-arrow'), heal: value('.landing-heal-note'), caption: value('.landing-figure-one figcaption'), node: value('.landing-node'), nodeStrong: value('.landing-node strong'), nodePrompt: value('.landing-node > span'), hotNode: value('.landing-node-hot'), coolNode: value('.landing-node-cool'), flow: value('.landing-flow'), healLead: value('.landing-heal-lead'), footer: value('.landing-footer'), footerLink: value('.landing-footer a'), footerMit: value('.landing-footer nav span'), status: value('.demo-status-row'), install: value('.landing-actions code'),
      };
    });
    assert.equal(computed.body.backgroundColor, 'rgb(16, 12, 9)');
    assert.equal(computed.body.backgroundImage, 'radial-gradient(1400px 900px at 50% -260px, rgba(201, 118, 43, 0.18), rgba(201, 118, 43, 0.05) 50%, rgba(0, 0, 0, 0) 80%)');
    assert.equal(computed.header.borderBottomColor, 'rgba(201, 118, 43, 0.22)');
    assert.equal(computed.hero.gridTemplateColumns.split(' ')[1], '640px');
    assert.equal(computed.arrow.whiteSpace, 'normal'); assert.equal(computed.arrow.maxWidth, '88px');
    assert.equal(computed.hero.overflow, 'visible'); assert.equal(computed.hero.isolation, 'isolate');
    assert.equal(computed.heroGlow.height, '900px'); assert.equal(computed.heroGlow.top, '-360px'); assert.equal(computed.heroGlow.left, '-200px'); assert.equal(computed.heroGlow.right, '-200px');
    assert.equal(computed.heroGlow.zIndex, '-1'); assert.equal(computed.heroGlow.pointerEvents, 'none');
    assert.equal(computed.heroGlow.backgroundImage, 'radial-gradient(50% 50%, rgba(201, 118, 43, 0.22), rgba(201, 118, 43, 0.06) 50%, rgba(0, 0, 0, 0) 78%)'); assert.equal(computed.mark.filter, 'none'); assert.equal(computed.mark.boxShadow, 'none'); assert.equal(computed.figureGlow.height, '640px'); assert.equal(computed.figureGlow.left, '-120px'); assert.equal(computed.figureGlow.right, '-120px');
    assert.notEqual(computed.figureGlow.backgroundImage, computed.browserGlow.backgroundImage, 'figure is permanently lit while the browser exhibit stays dim before run.');
    assert.equal(computed.figureGlow.backgroundImage, 'radial-gradient(50% 50%, rgba(232, 176, 99, 0.44), rgba(201, 118, 43, 0.12) 50%, rgba(0, 0, 0, 0) 80%)');
    assert.equal(computed.planGlow.backgroundImage, computed.figureGlow.backgroundImage, 'plan is lit after generate, matching the always-lit figure.');
    assert.equal(computed.browserGlow.backgroundImage, 'radial-gradient(50% 50%, rgba(232, 176, 99, 0.16), rgba(201, 118, 43, 0.05) 50%, rgba(0, 0, 0, 0) 80%)');
    assert.equal(computed.panel.backgroundColor, 'rgb(46, 38, 32)'); assert.match(computed.panel.backgroundImage, /linear-gradient/); assert.equal(computed.panel.borderColor, 'rgba(201, 118, 43, 0.38)'); assert.match(computed.panel.boxShadow, /rgba\(0, 0, 0, 0\.95\)/);
    assert.equal(computed.litPanel.boxShadow, 'rgba(241, 205, 152, 0.6) 0px 1px 0px 0px inset, rgba(16, 12, 9, 0.9) 0px 0px 0px 1px, rgba(201, 118, 43, 0.1) 0px 0px 0px 4px, rgba(201, 118, 43, 0.45) 0px 28px 70px -24px');
    assert.equal(computed.panel.transitionDuration, '0s'); assert.equal(computed.panelHeader.padding, '12px 16px');
    assert.equal(computed.panelFooter.padding, '10px 16px'); assert.equal(computed.panelFooter.minHeight, '20px'); assert.equal(computed.panelPre.fontSize, '13px'); assert.equal(computed.panelPre.lineHeight, '22.75px'); assert.equal(computed.planPre.fontSize, '11.5px');
    assert.equal(computed.pill.height, '22px'); assert.equal(computed.pill.padding, '0px 9px'); assert.equal(computed.pillDot.width, '7px'); assert.equal(computed.pillDot.height, '7px');
    assert.equal(computed.stage.marginTop, '20px');
    assert.equal(computed.button.fontSize, '15px'); assert.equal(computed.button.fontWeight, '700'); assert.equal(computed.button.padding, '0px 14px'); assert.equal(computed.button.whiteSpace, 'nowrap'); assert.equal(computed.browser.backgroundColor, 'rgb(16, 12, 9)');
    assert.equal(computed.ledger.backgroundColor, 'rgb(28, 22, 18)'); assert.equal(computed.ledger.borderRadius, '14px'); assert.equal(computed.ledger.padding, '0px 24px'); assert.match(computed.ledgerRow.gridTemplateColumns, /^56px 260px /); assert.equal(computed.ledgerRow.gap, '28px'); assert.equal(computed.ledgerRow.padding, '22px 0px'); assert.equal(computed.ledgerNumber.fontSize, '28px'); assert.equal(computed.ledgerNumber.fontWeight, '800'); assert.equal(computed.ledgerNumber.color, 'rgb(201, 118, 43)'); assert.equal(computed.ledgerCommand.fontSize, '15px'); assert.equal(computed.ledgerCommand.backgroundColor, 'rgba(0, 0, 0, 0)'); assert.equal(computed.ledgerPill.height, '22px'); assert.equal(computed.ledgerLastRow.borderBottomStyle, 'none');
    assert.equal(computed.sectionWash.height, '200px'); assert.equal(computed.section.padding, '64px 0px'); assert.match(computed.prereq.gridTemplateColumns, /^140px /); assert.equal(computed.prereqCell.padding, '16px 0px'); assert.equal(computed.prereqLabel.fontSize, '11px'); assert.equal(computed.prereqValue.fontSize, '14px'); assert.equal(computed.prereqNote.fontSize, '15px');
    assert.equal(computed.node.fontSize, '13px'); assert.equal(computed.node.padding, '18px 12px'); assert.equal(computed.node.color, 'rgb(255, 253, 250)'); assert.equal(computed.node.backdropFilter, 'blur(18px) saturate(1.3)'); assert.equal(computed.nodeStrong.fontSize, '13px'); assert.equal(computed.nodeStrong.color, 'rgb(255, 253, 250)'); assert.equal(computed.nodePrompt.color, 'rgb(201, 189, 174)'); assert.equal(computed.hotNode.boxShadow, 'rgba(255, 245, 230, 0.4) 0px 1px 0px 0px inset, rgba(219, 145, 64, 0.35) 0px 0px 36px 0px, rgba(0, 0, 0, 0.85) 0px 18px 40px -18px'); assert.equal(computed.coolNode.boxShadow, 'rgba(255, 245, 230, 0.32) 0px 1px 0px 0px inset, rgba(255, 245, 230, 0.06) 0px -1px 0px 0px inset, rgba(0, 0, 0, 0.85) 0px 18px 40px -18px'); assert.equal(computed.flow.gap, '16px 14px'); assert.equal(computed.heal.gridColumn, '2 / 5'); assert.equal(computed.heal.fontSize, '11px'); assert.equal(computed.healLead.fontWeight, '500');
    const replayNode = await page.locator('.landing-node-cool').evaluate((node) => {
      const strong = node.querySelector('strong');
      const span = document.querySelector('.landing-node-cool > span');
      const range = document.createRange();
      range.selectNodeContents(span);
      return { strongLines: strong?.getClientRects().length, specimenLines: range.getClientRects().length };
    });
    assert.equal(replayNode.strongLines, 1, 'The replay node label must remain on one line.');
    assert.equal(replayNode.specimenLines, 1, 'The replay specimen must stay on one line.');
    assert.equal(computed.status.borderTopStyle, 'dashed'); assert.equal(computed.status.padding, '14px 0px 0px'); assert.equal(computed.install.backgroundColor, 'rgb(46, 38, 32)'); assert.equal(computed.install.borderColor, 'rgba(201, 118, 43, 0.38)'); assert.equal(computed.footer.padding, '28px 0px'); assert.equal(computed.footerLink.fontSize, '13px'); assert.equal(computed.footerMit.fontSize, '13px');
    for (const [label, item, base] of [
      ['ledger description', computed.ledgerDescription, 'rgb(28, 22, 18)'], ['prerequisite note', computed.prereqNote, 'rgb(28, 22, 18)'],
      ['prompt body', computed.prompt, 'rgb(46, 38, 32)'], ['prompt heading', computed.promptHeading, 'rgb(46, 38, 32)'], ['prompt grant', computed.promptGrant, 'rgb(46, 38, 32)'], ['JSON key', computed.key, 'rgb(46, 38, 32)'], ['JSON value', computed.jsonValue, 'rgb(46, 38, 32)'],
      ['panel header label', computed.panelHeader, 'rgb(36, 29, 24)'], ['panel footer label', computed.panelFooter, 'rgb(36, 29, 24)'], ['heal note', computed.heal, 'rgb(16, 12, 9)'], ['arrow', computed.arrow, 'rgb(16, 12, 9)'],
    ]) assert.ok(contrastRatio(item.color, base) >= 4.5, `${label} must meet AA contrast.`);
    for (const [label, item] of [['ledger description', computed.ledgerDescription], ['prerequisite note', computed.prereqNote], ['prerequisite label', computed.prereqLabel], ['heal note', computed.heal], ['arrow', computed.arrow], ['node second line', computed.nodePrompt], ['caption', computed.caption], ['panel footer', computed.panelFooter]]) assert.equal(item.color, 'rgb(201, 189, 174)', `${label} must use resin-300.`);
    await page.locator('.landing-ledger-row').first().hover();
    assert.match(await page.locator('.landing-ledger-row').first().evaluate((node) => getComputedStyle(node).backgroundImage), /linear-gradient/);
    const panelGeometry = await page.locator('.demo-panel').evaluateAll((panels) => panels.map((panel) => ({ top: panel.getBoundingClientRect().top, minHeight: getComputedStyle(panel).minHeight })));
    assert.ok(panelGeometry.every(({ top }) => Math.abs(top - panelGeometry[0].top) <= 1)); assert.ok(panelGeometry.every(({ minHeight }) => minHeight === '380px'));
    assert.equal(await page.locator('#demo-prompt-panel pre').evaluate((node) => node.scrollHeight <= node.clientHeight), true);
    assert.equal(await page.locator('.demo-stage > *').evaluateAll((elements) => elements.every((element) => getComputedStyle(element).marginTop === '0px')), true);
  } finally { await context.close(); }
}

async function assertGutterClearance(browser) {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  try {
    for (const locale of LOCALE_ROOTS) {
      await page.goto(pageUrl(locale.path), { waitUntil: 'networkidle' });
      const { demo, generate, run, status } = demoControls(page);
      const assertState = async (state) => {
        const result = await demo.evaluate(() => {
          const stage = document.querySelector('.demo-stage');
          if (!stage) throw new Error('Missing .demo-stage');
          const tracks = getComputedStyle(stage).gridTemplateColumns.split(' ');
          const actions = ['#demo-generate', '#demo-run'].map((buttonSelector) => {
            const button = document.querySelector(buttonSelector).getBoundingClientRect();
            const panels = buttonSelector === '#demo-generate'
              ? ['#demo-prompt-panel', '#demo-plan-panel']
              : ['#demo-plan-panel', '#demo-browser-panel'];
            const [leftPanel, rightPanel] = panels.map((selector) => document.querySelector(selector).getBoundingClientRect());
            return { left: button.left - leftPanel.right, right: rightPanel.left - button.right };
          });
          return { second: parseFloat(tracks[1]), fourth: parseFloat(tracks[3]), justifySelf: getComputedStyle(document.querySelector('.demo-action')).justifySelf, actions };
        });
        assert.ok(result.second >= 132, `${locale.path} ${state} second track must be at least 132px.`);
        assert.ok(result.fourth >= 132, `${locale.path} ${state} fourth track must be at least 132px.`);
        assert.equal(result.justifySelf, 'center', `${locale.path} ${state} demo actions must be centered.`);
        for (const [index, gaps] of result.actions.entries()) {
          assert.ok(gaps.left >= 8, `${locale.path} ${state} action ${index} must have at least 8px from the left panel.`);
          assert.ok(gaps.right >= 8, `${locale.path} ${state} action ${index} must have at least 8px from the right panel.`);
        }
      };
      await assertState('idle');
      await generate.click();
      await waitForText(status, /cast/i, `${locale.path} reduced-motion Generate must reach cast synchronously.`);
      await assertState('cast');
      await run.click();
      await waitForText(status, /exit 0/i, `${locale.path} reduced-motion Run must reach done synchronously.`);
      await assertState('done');
    }
  } finally { await context.close(); }
}

async function assertSsrClientBuilderEquality(browser) {
  const noScript = await browser.newContext({ javaScriptEnabled: false, colorScheme: 'dark', viewport: { width: 1440, height: 1100 } });
  const fallback = await noScript.newPage();
  let expected;
  try {
    await fallback.goto(pageUrl('/'), { waitUntil: 'networkidle' });
    expected = await fallback.evaluate(() => ({
      lit: document.querySelector('#ambercast-demo')?.getAttribute('data-demo-lit'),
      panels: ['#demo-prompt-panel', '#demo-plan-panel', '#demo-browser-panel'].map((selector) => document.querySelector(selector)?.innerHTML),
    }));
    assert.equal(expected.lit, 'browser');
    assert.match(expected.panels[0] ?? '', /demo-prompt-line/);
    assert.match(expected.panels[1] ?? '', /demo-plan-marker-ok[^>]*>✓/);
    assert.match(expected.panels[2] ?? '', /Welcome, Mika/);
  } finally { await noScript.close(); }
  const context = await browser.newContext({ colorScheme: 'dark', reducedMotion: 'reduce', viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl('/'), { waitUntil: 'networkidle' });
    const { generate, run, status } = demoControls(page);
    await generate.click(); await waitForText(status, /cast/i, 'Reduced-motion Generate must reach cast synchronously.');
    await run.click(); await waitForText(status, /exit 0/i, 'Reduced-motion Run must reach done synchronously.');
    const actual = await page.evaluate(() => ({
      lit: document.querySelector('#ambercast-demo')?.getAttribute('data-demo-lit'),
      panels: ['#demo-prompt-panel', '#demo-plan-panel', '#demo-browser-panel'].map((selector) => document.querySelector(selector)?.innerHTML),
    }));
    assert.equal(actual.lit, 'browser', 'Client comparison requires an explicit done spotlight.');
    assert.match(actual.panels[0] ?? '', /demo-prompt-line/, 'Client done must retain prompt markup.');
    assert.match(actual.panels[1] ?? '', /demo-plan-marker-ok[^>]*>✓/, 'Client done must retain completed plan markers.');
    assert.match(actual.panels[2] ?? '', /Welcome, Mika/, 'Client done must render the completed dashboard.');
    // Both values use Chromium serialization; whitespace intentionally remains part of the byte contract.
    assert.deepEqual(actual, expected, 'SSR fallback and done client panels must share builder bytes.');
    assert.equal(actual.lit, 'browser');
  } finally { await context.close(); }
}

async function assertLightThemeFlat(browser) {
  for (const [width, panelHeight] of [[1440, '380px'], [390, '0px']]) {
    const context = await browser.newContext({ colorScheme: 'light', reducedMotion: 'reduce', viewport: { width, height: 844 } });
    const page = await context.newPage();
    try {
      await page.goto(pageUrl('/'), { waitUntil: 'networkidle' });
      await waitForFonts(page);
      const { generate, status } = demoControls(page);
      await generate.click();
      await waitForText(status, /cast/i, 'Light-theme Generate must reach cast before style evaluation.');
      assert.equal(await page.locator('body').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(250, 246, 240)');
      assert.deepEqual(await page.evaluate(() => Object.fromEntries([
        ['panel', '.demo-panel'], ['ledger', '.landing-ledger'], ['node', '.landing-node'], ['chip', '.landing-actions code'],
      ].map(([name, selector]) => [name, getComputedStyle(document.querySelector(selector)).backgroundColor]))), {
        panel: 'rgb(241, 235, 226)', ledger: 'rgba(0, 0, 0, 0)', node: 'rgb(241, 235, 226)', chip: 'rgb(241, 235, 226)',
      });
      for (const selector of ['.landing-hero', '[data-exhibit="figure"]', '[data-exhibit="prompt"]', '[data-exhibit="plan"]', '[data-exhibit="browser"]']) {
        assert.equal(await page.locator(selector).evaluate((node) => getComputedStyle(node, '::before').display), 'none', `${selector} glow must be absent in light theme.`);
      }
      assert.deepEqual(await page.evaluate(() => {
        const style = (selector) => {
          const element = document.querySelector(selector);
          if (!element) throw new Error('Missing ' + selector);
          return getComputedStyle(element);
        };
        return {
          plan: { fontSize: style('#demo-plan-panel pre').fontSize, lineHeight: style('#demo-plan-panel pre').lineHeight, fontWeight: style('#demo-plan-panel pre').fontWeight },
          prompt: { fontSize: style('#demo-prompt-panel pre').fontSize, lineHeight: style('#demo-prompt-panel pre').lineHeight, fontWeight: style('#demo-prompt-panel pre').fontWeight },
          heading: { fontSize: style('.demo-prompt-heading').fontSize, lineHeight: style('.demo-prompt-heading').lineHeight, fontWeight: style('.demo-prompt-heading').fontWeight },
          panelMinHeight: style('.demo-panel').minHeight,
        };
      }), {
        plan: { fontSize: width === 390 ? '10.5px' : '11.5px', lineHeight: width === 390 ? '17.85px' : '19.55px', fontWeight: '500' },
        prompt: { fontSize: '13px', lineHeight: '22.75px', fontWeight: '500' },
        heading: { fontSize: '13px', lineHeight: '22.75px', fontWeight: '600' },
        panelMinHeight: panelHeight,
      }, 'Light ' + width + 'px typography and panel geometry must retain the theme-independent contract.');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
    } finally { await context.close(); }
  }
}

async function assertGenerationFrameTiming(browser) {
  const context = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl('/'), { waitUntil: 'networkidle' });
    await page.clock.install();
    const { generate, status } = demoControls(page);
    await generate.click();
    const lines = page.locator('#demo-plan-panel .demo-plan-line');
    const visibleCount = () => page.locator('#demo-plan-panel .demo-plan-line-visible').count();
    const visibleSteps = () => page.locator('#demo-plan-panel [data-plan-step].demo-plan-line-visible').count();
    assert.equal(await visibleCount(), 0, 'Generate must begin with every generated plan line hidden.');
    await page.clock.runFor(89);
    assert.equal(await visibleCount(), 0, 'No plan line may appear before the 90ms structural boundary.');
    await page.clock.runFor(1);
    assert.equal(await visibleCount(), 1, 'The first structural line must appear at 90ms.');
    await page.clock.runFor(90);
    assert.equal(await visibleCount(), 2, 'The second structural line must appear at the next 90ms boundary.');
    await page.clock.runFor(90);
    assert.equal(await visibleCount(), 3, 'The third structural line must appear at the next 90ms boundary.');
    await page.clock.runFor(90);
    assert.equal(await visibleCount(), 4, 'The steps container must appear at the next 90ms boundary.');
    for (let step = 1; step <= 6; step += 1) {
      await page.clock.runFor(230);
      assert.equal(await visibleSteps(), step, 'Generation must reveal replay step ' + step + ' at its 230ms boundary.');
      assert.equal(await visibleCount(), step + 4, 'Generation must reveal the expected total line count.');
    }
    assert.equal(await lines.count(), 13, 'The plan frame oracle must observe every generated display line.');
    for (let structuralLine = 1; structuralLine <= 3; structuralLine += 1) {
      await page.clock.runFor(90);
      assert.equal(await visibleCount(), structuralLine + 10, 'Generation must reveal trailing structural lines at 90ms boundaries.');
    }
    await page.clock.runFor(250);
    assert.doesNotMatch(await status.textContent() ?? '', /cast/i, 'Generation must stay in gen until the 300ms settle boundary.');
    await page.clock.runFor(50);
    assert.match(await status.textContent() ?? '', /cast/i, 'Generation must settle into cast by the 300ms settle boundary.');
  } finally { await context.close(); }
}

async function assertResponsiveAndDocumentationInvariants(browser) {
  const guide = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1440, height: 1100 } });
  const guidePage = await guide.newPage();
  try {
    await guidePage.goto(pageUrl('/guides/getting-started/'), { waitUntil: 'networkidle' });
    assert.equal(await guidePage.locator('body').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(24, 19, 16)');
  } finally { await guide.close(); }
  for (const [width, heroPadding, heroSize, flowGap, planSize, sectionPadding, panelHeight] of [[1440, '72px 0px 56px', '44px', '16px 14px', '11.5px', '64px 0px', '380px'], [390, '40px 0px', '36px', '10px', '10.5px', '40px 0px', '0px']]) {
    const context = await browser.newContext({ colorScheme: 'dark', reducedMotion: 'reduce', viewport: { width, height: 1100 } }); const page = await context.newPage();
    try {
      await page.goto(pageUrl('/'), { waitUntil: 'networkidle' });
      const { generate, status } = demoControls(page);
      await generate.click(); await waitForText(status, /cast/i, `${width}px Generate must render the plan before responsive assertions.`);
      const values = await page.evaluate(() => ({
        landing: getComputedStyle(document.querySelector('.landing-page')).padding,
        hero: getComputedStyle(document.querySelector('.landing-hero')).padding,
        title: getComputedStyle(document.querySelector('.landing-hero h1')).fontSize,
        flow: getComputedStyle(document.querySelector('.landing-flow')).gap,
        plan: getComputedStyle(document.querySelector('#demo-plan-panel pre')).fontSize,
        section: getComputedStyle(document.querySelector('.landing-section')).padding,
        panel: getComputedStyle(document.querySelector('.demo-panel')).minHeight,
        heal: getComputedStyle(document.querySelector('.landing-heal-note')).gridColumn,
        arrowMaxWidth: getComputedStyle(document.querySelector('.landing-arrow')).maxWidth,
      }));
      assert.equal(values.landing, '0px'); assert.equal(values.hero, heroPadding); assert.equal(values.title, heroSize); assert.equal(values.flow, flowGap); assert.equal(values.plan, planSize); assert.equal(values.section, sectionPadding); assert.equal(values.panel, panelHeight); assert.equal(values.heal, width === 390 ? '1' : '2 / 5');
      if (width === 390) assert.equal(values.arrowMaxWidth, 'none');
      if (width === 1440) assert.equal(await page.locator('.landing-hero h1').evaluate((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getClientRects().length;
      }), 1);
    } finally { await context.close(); }
  }
}

async function assertApprovedCopyAndNoClipping(browser) {
  const copies = {
    '/': { title: 'Prompt-native E2E testing.', summary: 'Cast once. Keep the intent intact. Write the test as a Markdown prompt, generate a plan once, replay it deterministically: 0 AI calls whenever the cache hits.', commands: ['ambercast generate', 'ambercast run', 'ambercast heal'], descriptions: ['Reads the prompt, writes plan and grounding as plain JSON. Review them like a lockfile.', 'Replays the plan in a real browser. A cache miss falls back to one AI-assisted step; --cache-only enforces the no-AI path.', 'When the UI drifts, re-resolves, repairs or regenerates only the affected steps, and asks before writing.'], prerequisites: ['Node.js ≥ 22.14', 'npx playwright-core install chromium. Chromium only, for now.', 'claude or codex CLI, installed and authenticated. Default ai.provider: "auto" looks for claude, then codex.'], footer: `GitHubnpm v${PACKAGE_VERSION}ChangelogMITPRE-1.0 · CHROMIUM · LOCAL` },
    '/ja/': { title: 'プロンプトネイティブな E2E テスト。', summary: '一度鋳込み、意図をそのまま保つ。テストを Markdown プロンプトとして書き、プランを一度だけ生成し、決定的にリプレイする。キャッシュが命中する限り AI 呼び出しは 0 回。', commands: ['ambercast generate', 'ambercast run', 'ambercast heal'], descriptions: ['プロンプトを読み、プランとグラウンディングを素の JSON として書き出す。ロックファイルのようにレビューできる。', 'プランを実ブラウザでリプレイする。キャッシュミス時はその 1 ステップだけ AI 補助にフォールバックし、--cache-only で AI なしの経路を強制できる。', 'UI がドリフトしたとき、影響を受けたステップだけを再解決・修復・再生成し、書き込み前に確認を求める。'], prerequisites: ['Node.js ≥ 22.14', 'npx playwright-core install chromium。現時点では Chromium のみ。', 'インストール・認証済みの claude または codex CLI。既定の ai.provider: "auto" は claude、次に codex の順に探す。'], footer: `GitHubnpm v${PACKAGE_VERSION}ChangelogMITPRE-1.0 · CHROMIUM · LOCAL` },
    '/zh-cn/': { title: '提示词原生的 E2E 测试。', summary: '铸造一次，意图完整保留。用 Markdown 提示词编写测试，只生成一次执行计划，然后确定性地回放：只要缓存命中，AI 调用为 0。', commands: ['ambercast generate', 'ambercast run', 'ambercast heal'], descriptions: ['读取提示词，把执行计划和定位缓存写成纯 JSON。像锁文件一样复核它们。', '在真实浏览器中回放执行计划。缓存未命中时仅对该步骤回退为 AI 辅助；--cache-only 可强制无 AI 路径。', '当 UI 发生漂移时，只重新解析、修复或重新生成受影响的步骤，并在写入前请求确认。'], prerequisites: ['Node.js ≥ 22.14', 'npx playwright-core install chromium。目前仅支持 Chromium。', '已安装并完成身份验证的 claude 或 codex CLI。默认 ai.provider: "auto" 先查找 claude，再查找 codex。'], footer: `GitHubnpm v${PACKAGE_VERSION}ChangelogMITPRE-1.0 · CHROMIUM · LOCAL` },
  };
  for (const [path, copy] of Object.entries(copies)) {
    const context = await browser.newContext({ colorScheme: 'dark', reducedMotion: 'reduce', viewport: { width: 1440, height: 1100 } }); const page = await context.newPage();
    try {
      await page.goto(pageUrl(path), { waitUntil: 'networkidle' });
      const { generate, status } = demoControls(page);
      await generate.click(); await waitForText(status, /cast/i, `${path} Generate must render the plan before clipping assertions.`);
      assert.equal(await page.locator('#landing-title').textContent(), copy.title); assert.equal(await page.locator('.landing-summary').textContent(), copy.summary);
      assert.deepEqual(await page.locator('.landing-ledger-row code').allTextContents(), copy.commands); assert.deepEqual(await page.locator('.landing-ledger-row p').allTextContents(), copy.descriptions);
      assert.deepEqual(await page.locator('.landing-prerequisites dd').allTextContents(), copy.prerequisites); assert.equal((await page.locator('.landing-footer').textContent())?.replaceAll(/\s+/g, ''), copy.footer.replaceAll(/\s+/g, ''));
      const prerequisiteTopology = await page.locator('.landing-prerequisites dd').evaluateAll((entries) => entries.map((entry) => ({
        children: [...entry.children].map((child) => child.className),
        codes: [...entry.querySelectorAll('code')].map((code) => ({ text: code.textContent, parent: code.parentElement?.className })),
      })));
      for (const entry of prerequisiteTopology) {
        assert.equal(entry.children[0], 'landing-prereq-value');
        if (entry.children.length > 1) assert.equal(entry.children[1], 'landing-prereq-sep');
        if (entry.children.length > 2) assert.equal(entry.children[2], 'landing-prereq-note');
      }
      assert.deepEqual(prerequisiteTopology[0].codes, [{ text: 'Node.js ≥ 22.14', parent: 'landing-prereq-value' }]);
      assert.deepEqual(prerequisiteTopology[1].codes, [{ text: 'npx playwright-core install chromium', parent: 'landing-prereq-value' }]);
      assert.deepEqual(prerequisiteTopology[2].codes.map((code) => code.parent), ['landing-prereq-value', 'landing-prereq-value', 'landing-prereq-note']);
      assert.equal(prerequisiteTopology[2].codes[2].text, 'ai.provider: "auto"');
      const labels = await page.locator('.ac-label').allTextContents(); for (const label of labels) assert.match(label, /^[\x00-\x7F·]*$/, `${path} specimen labels must remain ASCII apart from the middle dot.`);
      assert.equal(await page.locator('.landing-node > strong').evaluateAll((nodes) => nodes.every((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getClientRects().length === 1;
      })), true, `${path} node labels must remain on one line.`);
      assert.equal(await page.locator('.landing-node, .landing-ledger-row, .landing-prerequisites dt, .landing-prerequisites dd, .landing-footer, #demo-plan-panel pre').evaluateAll((elements) => elements.every((element) => element.scrollWidth <= element.clientWidth + 1)), true);
    } finally { await context.close(); }
  }
}

async function captureBoundaryAndPhaseScreenshots(browser) {
  await mkdir(SCREENSHOT_DIRECTORY, { recursive: true });
  for (const [width, expectedColumns, browserPlacement] of [[1151, 2, '1 / -1'], [1152, 5, 'auto'], [799, 1, 'auto'], [800, 2, '1 / -1']]) {
    const context = await browser.newContext({ colorScheme: 'dark', viewport: { width, height: 900 } }); const page = await context.newPage();
    try {
      await page.goto(pageUrl('/'), { waitUntil: 'networkidle' }); await waitForFonts(page);
      const columns = await page.locator('.demo-stage').evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length);
      assert.equal(columns, expectedColumns, `${width}px must use its specified stage grid.`);
      assert.equal(await page.locator('[data-exhibit="browser"]').evaluate((node) => getComputedStyle(node).gridColumn), browserPlacement);
      await page.screenshot({ path: resolve(SCREENSHOT_DIRECTORY, `landing-${width}-dark.png`), fullPage: true });
    } finally { await context.close(); }
  }
  const context = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1440, height: 1100 } }); const page = await context.newPage();
  try {
    await page.goto(pageUrl('/'), { waitUntil: 'networkidle' }); await waitForFonts(page); await page.clock.install();
    const { generate, run, status, demo } = demoControls(page);
    const captures = [['gen', generate, /generate/i, 'plan', 0], ['cast', null, /cast/i, 'plan', 2500], ['run', run, /replay/i, 'browser', 0], ['done', null, /exit 0/i, 'browser', 2500]];
    for (const [name, action, text, lit, advance] of captures) {
      if (action) await action.click(); if (advance) await page.clock.runFor(advance);
      // Status plus data-demo-lit prevents a screenshot from observing an intermediate phase.
      await waitForText(status, text, `${name} phase did not reach its status.`); assert.equal(await demo.getAttribute('data-demo-lit'), lit);
      await page.addStyleTag({ content: '*{transition:none!important;animation:none!important}' });
      await page.screenshot({ path: resolve(SCREENSHOT_DIRECTORY, `landing-1440-dark-${name}.png`), fullPage: true });
    }
  } finally { await context.close(); }
}

async function assertLocaleRoots(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    for (const locale of LOCALE_ROOTS) {
      const response = await page.goto(pageUrl(locale.path), { waitUntil: 'networkidle' });
      assert.ok(response?.ok(), `${locale.path} must render successfully.`);
      assert.equal(await page.locator('html').getAttribute('lang'), locale.lang);
      await assertBasePath(page);
      const expectedLabels = LOCALE_DEMO_LABELS[locale.path];
      const controls = demoControls(page);
      assert.equal(await controls.demo.getAttribute('aria-label'), expectedLabels.tryIt, `${locale.path} demo aria-label must be localized.`);
      assert.equal(await controls.generate.textContent(), expectedLabels.generate, `${locale.path} Generate button must be localized.`);
      assert.equal(await controls.run.textContent(), expectedLabels.run, `${locale.path} Run button must be localized.`);
      assert.equal(await controls.demo.getAttribute('data-run-again-label'), expectedLabels.runAgain, `${locale.path} data-run-again-label must be localized.`);
      assert.equal(await controls.reset.textContent(), expectedLabels.reset, `${locale.path} Reset button must be localized.`);
      const nodeWidths = await page.$$eval('.landing-node', (nodes) => nodes.map((n) => n.getBoundingClientRect().width));
      for (const width of nodeWidths) {
        assert.ok(width >= 60, `${locale.path} .landing-node width ${width}px is suspiciously narrow (CJK grid-column collapse regression?).`);
      }
    }
  } finally {
    await context.close();
  }
}

function demoControls(page) {
  const demo = page.locator('#ambercast-demo');

  return {
    demo,
    generate: demo.locator('#demo-generate'),
    run: demo.locator('#demo-run'),
    reset: demo.locator('#demo-reset'),
    counter: demo.locator('#demo-counter'),
    status: demo.locator('#demo-status'),
  };
}

async function assertCounters(counter, runs, aiCalls) {
  assert.match(await counter.textContent() ?? '', new RegExp(`RUNS\\s+${runs}\\s+·\\s+AI CALLS\\s+${aiCalls}`, 'i'));
}

async function assertNativeDisabled(button, expected, message) {
  const nativeState = await button.evaluate((element) => ({
    disabled: element instanceof HTMLButtonElement && element.disabled,
    hasDisabledAttribute: element.hasAttribute('disabled'),
    isButton: element instanceof HTMLButtonElement,
  }));

  assert.equal(nativeState.isButton, true, `${message} The control must remain a native button.`);
  assert.equal(await button.isDisabled(), expected, message);
  assert.equal(nativeState.disabled, expected, `${message} The disabled property must match.`);
  assert.equal(nativeState.hasDisabledAttribute, expected, `${message} The disabled attribute must match.`);
}

async function assertAnimationName(locator, pseudoElement, expected, message) {
  const animationName = await locator.evaluate(
    (element, pseudo) => getComputedStyle(element, pseudo).animationName,
    pseudoElement,
  );

  assert.equal(animationName, expected, message);
}

async function assertPartialTyping(page, selector, finalValue, label) {
  const deadline = Date.now() + TYPING_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const value = await page.locator(selector).textContent();
    if (value && value !== finalValue) return;
    await sleep(10);
  }

  throw new Error(`${label} must reveal an intermediate value before the full value.`);
}

async function assertPersistentStatusNode(statusNode) {
  assert.equal(
    await statusNode.evaluate((node) => document.querySelector('#demo-status') === node),
    true,
    '#demo-status must remain the same DOM node across phase transitions.',
  );
}

async function assertLiveRegion(page, status) {
  assert.equal(await status.count(), 1, '#demo-status must be unique.');
  assert.equal(await status.getAttribute('aria-live'), 'polite', '#demo-status must announce status updates politely.');
  assert.equal(await page.locator('[aria-live]').count(), 1, '#demo-status must be the page’s sole explicit live region.');

  for (const role of LIVE_REGION_ROLES) {
    const roleRegions = page.getByRole(role, { includeHidden: true });
    const roleCount = await roleRegions.count();

    assert.ok(roleCount <= 1, `#demo-status must be the sole live region; found ${roleCount} elements with role ${role}.`);
    if (roleCount === 1) {
      assert.equal(
        await roleRegions.evaluate((node) => document.querySelector('#demo-status') === node),
        true,
        `The element with live-region role ${role} must be #demo-status.`,
      );
    }
  }
}

async function waitForDemoPhase(page, status, statusNode, pattern, message) {
  await waitForText(status, pattern, message);
  await assertPersistentStatusNode(statusNode);
  await assertLiveRegion(page, status);
}

function watchForeignRequests(context) {
  const foreignRequests = [];

  context.on('request', (request) => {
    if (new URL(request.url()).origin !== origin) foreignRequests.push(request.url());
  });

  return foreignRequests;
}

function assertNoForeignRequests(foreignRequests) {
  assert.equal(foreignRequests.length, 0, `Demo actions left the page origin: ${foreignRequests.join(', ')}`);
}

async function openDemoPage(browser) {
  const context = await browser.newContext({
    colorScheme: 'dark',
    viewport: { width: 1440, height: 1100 },
  });
  const page = await context.newPage();
  const consoleErrors = [];

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  await page.goto(pageUrl('/'), { waitUntil: 'networkidle' });
  // Load CSS-declared faces before observing clicks so the request assertion measures the
  // demo's behavior, including text that first becomes visible in later phases.
  await waitForFonts(page);

  return { context, page, consoleErrors, ...demoControls(page) };
}

async function assertInteractiveBehavior(browser) {
  const { context, page, demo, generate, run, reset, counter, status, consoleErrors } = await openDemoPage(browser);

  try {
    await assertBasePath(page);
    await assertAssetsPresent();

    await Promise.all([generate, run, reset].map(async (button) => {
      assert.equal(await button.getAttribute('type'), 'button');
    }));
    await assertNativeDisabled(generate, false, 'Generate must be enabled in idle.');
    await assertNativeDisabled(run, true, 'Run must be disabled in idle.');
    await assertNativeDisabled(reset, false, 'Reset must become enabled once the adapter attaches.');
    await assertAnimationName(generate, null, 'demo-action-hint-ring', 'Generate must show the hint ring while it is actionable.');
    await assertAnimationName(run, null, 'none', 'Run must not show the hint ring while disabled.');
    await assertCounters(counter, 0, 0);
    assert.equal(await page.locator('[data-exhibit="plan"] .demo-panel').evaluate((node) => getComputedStyle(node).borderColor), 'rgba(201, 118, 43, 0.38)');
    assert.equal(await page.locator('[data-exhibit="prompt"] .demo-panel').evaluate((node) => getComputedStyle(node).borderColor), 'rgba(232, 176, 99, 0.85)');
    assert.deepEqual(await page.evaluate(() => {
      const paint = (selector) => {
        const style = getComputedStyle(document.querySelector(selector));
        return { backgroundImage: style.backgroundImage, boxShadow: style.boxShadow, borderColor: style.borderColor };
      };
      return {
        dim: paint('[data-exhibit="browser"] .demo-panel'),
        lit: paint('[data-exhibit="prompt"] .demo-panel'),
      };
    }), {
      dim: {
        backgroundImage: 'linear-gradient(rgba(201, 118, 43, 0.16), rgba(201, 118, 43, 0.04) 45%, rgba(0, 0, 0, 0) 75%), none',
        boxShadow: 'rgba(241, 205, 152, 0.35) 0px 1px 0px 0px inset, rgba(16, 12, 9, 0.9) 0px 0px 0px 1px, rgba(0, 0, 0, 0.95) 0px 28px 60px -24px',
        borderColor: 'rgba(201, 118, 43, 0.38)',
      },
      lit: {
        backgroundImage: 'linear-gradient(rgba(201, 118, 43, 0.16), rgba(201, 118, 43, 0.04) 45%, rgba(0, 0, 0, 0) 75%), none',
        boxShadow: 'rgba(241, 205, 152, 0.6) 0px 1px 0px 0px inset, rgba(16, 12, 9, 0.9) 0px 0px 0px 1px, rgba(201, 118, 43, 0.1) 0px 0px 0px 4px, rgba(201, 118, 43, 0.45) 0px 28px 70px -24px',
        borderColor: 'rgba(232, 176, 99, 0.85)',
      },
    }, 'Chromium panel paint serialization must remain the approved V4 dim/lit contract.');
    assert.deepEqual(await generate.evaluate((node) => {
      const style = getComputedStyle(node);
      return { backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage, borderColor: style.borderColor, borderBottomWidth: style.borderBottomWidth };
    }), { backgroundColor: 'rgb(59, 51, 44)', backgroundImage: 'linear-gradient(rgba(201, 118, 43, 0.14), rgba(0, 0, 0, 0)), none', borderColor: 'rgba(166, 92, 31, 0.5)', borderBottomWidth: '3px' });
    assert.deepEqual(await run.evaluate((node) => {
      const style = getComputedStyle(node);
      return { backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage, borderColor: style.borderColor, boxShadow: style.boxShadow, cursor: style.cursor, opacity: style.opacity };
    }), { backgroundColor: 'rgb(59, 51, 44)', backgroundImage: 'none', borderColor: 'rgba(166, 92, 31, 0.5)', boxShadow: 'none', cursor: 'not-allowed', opacity: '0.35' });
    await generate.hover();
    assert.deepEqual(await generate.evaluate((node) => {
      const style = getComputedStyle(node);
      return { backgroundColor: style.backgroundColor, borderColor: style.borderColor };
    }), { backgroundColor: 'rgb(85, 75, 66)', borderColor: 'rgb(118, 107, 96)' });
    assert.equal(await page.locator('.demo-panel').first().evaluate((node) => getComputedStyle(node).transitionDuration), '0.6s, 0.6s');
    assert.equal(await page.locator('.landing-ledger-row').first().evaluate((node) => getComputedStyle(node).transitionDuration), '0.3s');
    await assertLiveRegion(page, status);
    assert.match(await status.ariaSnapshot(), /idle/i);
    const statusNode = await status.elementHandle();
    assert.ok(statusNode, '#demo-status must render a DOM node.');
    await assertPersistentStatusNode(statusNode);

    const foreignRequests = watchForeignRequests(context);

    await generate.click();
    await assertNativeDisabled(generate, true, 'Generate must become natively disabled in gen.');
    await waitForDemoPhase(page, status, statusNode, /generat/i, 'Generate did not reach the gen state.');
    await assertNativeDisabled(generate, true, 'Generate must stay natively disabled in gen.');
    await assertNativeDisabled(run, true, 'Run must stay natively disabled in gen.');
    await assertAnimationName(generate, null, 'none', 'Generate must not show the hint ring while disabled.');
    await assertAnimationName(run, null, 'none', 'Run must not show the hint ring while disabled.');
    await assertAnimationName(
      page.locator('#demo-plan-panel .demo-pill-ai'),
      '::before',
      'demo-casting-blink',
      'The casting pill must show its blinking indicator during generation.',
    );
    await assertCounters(counter, 0, 1);
    await waitForDemoPhase(page, status, statusNode, /cast/i, 'Generate did not reach the cast state.');
    await assertNativeDisabled(generate, true, 'Generate must stay natively disabled in cast.');
    await assertNativeDisabled(run, false, 'Run must become enabled in cast.');
    await assertAnimationName(run, null, 'demo-action-hint-ring', 'Run must show the hint ring when it becomes actionable.');

    await run.click();
    await assertNativeDisabled(generate, true, 'Generate must stay natively disabled in run.');
    await waitForDemoPhase(page, status, statusNode, /(?:replay|cache hit)/i, 'Run did not reach the run state.');
    await assertNativeDisabled(generate, true, 'Generate must stay natively disabled throughout run.');
    await assertPartialTyping(page, '[data-demo-email]', 'mika@example.com', 'Email');
    await assertPartialTyping(page, '[data-demo-password]', '••••••••••', 'Password');
    await assertCounters(counter, 1, 1);
    await waitForDemoPhase(page, status, statusNode, /exit 0/i, 'Run did not reach the terminal replay state.');
    await assertNativeDisabled(generate, true, 'Generate must stay natively disabled in done.');
    assert.match(await page.locator('#demo-browser-panel').textContent() ?? '', /Welcome, Mika/);
    await assertCounters(counter, 1, 1);

    await reset.click();
    await waitForDemoPhase(page, status, statusNode, /idle/i, 'Reset did not return the demo to idle.');
    await assertNativeDisabled(generate, false, 'Generate must return to enabled in idle.');
    await assertNativeDisabled(run, true, 'Run must return to disabled in idle.');
    await assertNativeDisabled(reset, false, 'Reset must remain enabled in idle.');
    await assertCounters(counter, 0, 0);
    assertNoForeignRequests(foreignRequests);
    assert.deepEqual(consoleErrors, []);

  } finally {
    await context.close();
  }
}

async function assertGenerateKeyboardActivation(browser, key) {
  const { context, page, generate, counter, status } = await openDemoPage(browser);

  try {
    await generate.focus();
    await page.keyboard.press(key);
    await waitForText(status, /cast/i, `${key} did not activate Generate.`);
    await assertCounters(counter, 0, 1);
  } finally {
    await context.close();
  }
}

async function assertRunKeyboardActivation(browser, key) {
  const { context, page, generate, run, counter, status } = await openDemoPage(browser);

  try {
    await generate.click();
    await waitForText(status, /cast/i, 'Generate did not prepare Run for keyboard activation.');
    await run.focus();
    await page.keyboard.press(key);
    await waitForText(status, /exit 0/i, `${key} did not activate Run.`);
    await assertCounters(counter, 1, 1);
  } finally {
    await context.close();
  }
}

async function assertResetKeyboardActivation(browser, key) {
  const { context, page, generate, run, reset, counter, status } = await openDemoPage(browser);

  try {
    await generate.click();
    await waitForText(status, /cast/i, 'Generate did not prepare Reset for keyboard activation.');
    await run.click();
    await waitForText(status, /exit 0/i, 'Run did not prepare Reset for keyboard activation.');
    await reset.focus();
    await page.keyboard.press(key);
    await waitForText(status, /idle/i, `${key} did not activate Reset.`);
    await assertCounters(counter, 0, 0);
  } finally {
    await context.close();
  }
}

async function assertResetCancelsGeneration(browser) {
  const { context, page, generate, reset, counter, status } = await openDemoPage(browser);

  try {
    await page.clock.install();
    const foreignRequests = watchForeignRequests(context);
    const statusNode = await status.elementHandle();
    assert.ok(statusNode, '#demo-status must render a DOM node.');
    await generate.click();
    await waitForDemoPhase(page, status, statusNode, /generat/i, 'Generate did not reach the gen state before Reset.');
    await reset.click();
    await waitForDemoPhase(page, status, statusNode, /idle/i, 'Reset did not return gen to idle.');
    await assertCounters(counter, 0, 0);
    await page.clock.runFor(10_000);
    assert.match(await status.textContent() ?? '', /idle/i, 'A stale generation completion resurrected cast after Reset.');
    await assertCounters(counter, 0, 0);
    assertNoForeignRequests(foreignRequests);
  } finally {
    await context.close();
  }
}

async function assertResetCancelsRun(browser) {
  const { context, page, generate, run, reset, counter, status } = await openDemoPage(browser);

  try {
    await page.clock.install();
    const foreignRequests = watchForeignRequests(context);
    const statusNode = await status.elementHandle();
    assert.ok(statusNode, '#demo-status must render a DOM node.');
    await generate.click();
    await page.clock.runFor(10_000);
    await waitForDemoPhase(page, status, statusNode, /cast/i, 'Generate did not prepare run for Reset.');
    await run.click();
    await waitForDemoPhase(page, status, statusNode, /(?:replay|cache hit)/i, 'Run did not reach the run state before Reset.');
    await reset.click();
    await waitForDemoPhase(page, status, statusNode, /idle/i, 'Reset did not return run to idle.');
    await assertCounters(counter, 0, 0);
    await page.clock.runFor(10_000);
    assert.match(await status.textContent() ?? '', /idle/i, 'A stale run completion resurrected done after Reset.');
    await assertCounters(counter, 0, 0);
    assertNoForeignRequests(foreignRequests);
  } finally {
    await context.close();
  }
}

async function assertReducedMotion(browser) {
  const context = await browser.newContext({
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    viewport: { width: 1440, height: 1100 },
  });
  const page = await context.newPage();

  try {
    await page.goto(pageUrl('/'), { waitUntil: 'networkidle' });

    const demo = page.locator('#ambercast-demo');
    const status = demo.locator('#demo-status');
    const generate = demo.locator('#demo-generate');
    const run = demo.locator('#demo-run');
    const reset = demo.locator('#demo-reset');

    await assertAnimationName(generate, null, 'none', 'Reduced motion must suppress the Generate hint-ring animation.');
    await generate.click();
    assert.match(await status.textContent() ?? '', /cast/i);
    assert.doesNotMatch(await status.textContent() ?? '', /generate/i);
    await assertAnimationName(run, null, 'none', 'Reduced motion must suppress the Run hint-ring animation.');

    await run.click();
    assert.match(await status.textContent() ?? '', /exit 0/i);
    assert.match(await demo.locator('#demo-browser-panel').textContent() ?? '', /Welcome, Mika/);
    assert.equal(await demo.locator('[data-demo-email], [data-demo-password]').count(), 0, 'Reduced motion must render the terminal result without typing frames.');

    const blinkAnimation = await page.evaluate(() => {
      const host = document.querySelector('#demo-plan-panel') ?? document.querySelector('#ambercast-demo');
      if (!host) throw new Error('The demo container must exist for the blink probe.');
      const pill = document.createElement('span');
      pill.className = 'demo-pill demo-pill-ai';
      host.append(pill);
      const animationName = getComputedStyle(pill, '::before').animationName;
      pill.remove();
      return animationName;
    });
    assert.equal(blinkAnimation, 'none', 'Reduced motion must suppress the casting blink animation.');
    assert.equal(await demo.getAttribute('data-demo-lit'), 'browser');
    assert.equal(await page.locator('.demo-panel').first().evaluate((node) => getComputedStyle(node).transitionDuration), '0s');
    assert.equal(await page.locator('.landing-ledger-row').first().evaluate((node) => getComputedStyle(node).transitionDuration), '0s');
    await reset.click();
    assert.equal(await demo.getAttribute('data-demo-lit'), 'prompt');
  } finally {
    await context.close();
  }
}

async function assertHeaderV13(browser) {
  const locales = [
    { path: '/', docsPath: '/ambercast/guides/introduction/', label: 'Docs' },
    { path: '/ja/', docsPath: '/ambercast/ja/guides/introduction/', label: 'ドキュメント' },
    { path: '/zh-cn/', docsPath: '/ambercast/zh-cn/guides/introduction/', label: '文档' },
  ];

  for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]) {
    for (const locale of locales) {
      const context = await browser.newContext({ colorScheme: 'dark', viewport });
      const page = await context.newPage();
      try {
        await page.goto(pageUrl(locale.path), { waitUntil: 'networkidle' });
        await waitForFonts(page);
        const titleCenters = await page.locator('.ac-site-title').evaluate((title) => {
          const mark = title.querySelector('img');
          const wordmark = title.querySelector('.ac-site-title-wordmark');
          if (!mark || !wordmark || !wordmark.firstChild) throw new Error('The header title must contain its mark and wordmark.');
          const range = document.createRange();
          range.selectNodeContents(wordmark.firstChild);
          const markRect = mark.getBoundingClientRect();
          const wordmarkRect = range.getBoundingClientRect();
          return { mark: markRect.y + markRect.height / 2, wordmark: wordmarkRect.y + wordmarkRect.height / 2 };
        });
        assert.ok(Math.abs(titleCenters.mark - titleCenters.wordmark) <= 1, `${locale.path} at ${viewport.width}px must vertically center the mark and wordmark.`);

        const docs = page.locator('.ac-docs-link');
        await assert.equal(await docs.count(), 1, `${locale.path} must provide one Docs link.`);
        assert.equal(await docs.getAttribute('aria-label'), locale.label, `${locale.path} must retain its localized accessible Docs label.`);
        assert.equal(new URL(await docs.getAttribute('href'), page.url()).pathname, locale.docsPath, `${locale.path} must target its localized introduction.`);
        const fullLabel = docs.locator('.ac-docs-label');
        const shortLabel = docs.locator('.ac-docs-label-short');
        if (viewport.width >= 800) {
          assert.equal(await fullLabel.isVisible(), true, `${locale.path} at ${viewport.width}px must show its localized Docs label.`);
          assert.equal(await fullLabel.textContent(), locale.label, `${locale.path} must use its localized Docs label.`);
          assert.equal(await shortLabel.isHidden(), true, `${locale.path} at ${viewport.width}px must hide the short Docs label.`);
          const docsBox = await docs.boundingBox();
          assert.ok(docsBox && docsBox.width >= 44 && docsBox.height >= 44, `${locale.path} at ${viewport.width}px must keep Docs tappable at least 44×44.`);
        } else {
          assert.equal(await fullLabel.isHidden(), true, `${locale.path} at ${viewport.width}px must hide the localized Docs label.`);
          assert.equal(await shortLabel.isVisible(), true, `${locale.path} at ${viewport.width}px must show the short Docs label.`);
          assert.equal(await shortLabel.textContent(), 'Docs', `${locale.path} at ${viewport.width}px must use the shared short Docs label.`);
        }
      } finally {
        await context.close();
      }
    }
  }

  for (const path of ['/', '/ja/', '/zh-cn/', '/guides/getting-started/']) {
    const context = await browser.newContext({ colorScheme: 'dark', viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    try {
      await page.goto(pageUrl(path), { waitUntil: 'networkidle' });
      await waitForFonts(page);
      const docs = page.locator('.ac-docs-link');
      if (path === '/guides/getting-started/') {
        assert.equal(await docs.isHidden(), true, `${path} must hide the Docs link when its sidebar already provides documentation navigation.`);
      } else {
        assert.equal(await docs.isVisible(), true, `${path} must retain the Docs link on a landing page.`);
        const docsBox = await docs.boundingBox();
        assert.ok(docsBox && docsBox.width >= 44 && docsBox.height >= 44, `${path} at 390px must keep Docs tappable at least 44×44.`);
      }
      for (const selector of ['.ac-header-controls starlight-theme-select select', '.ac-header-controls starlight-lang-select select']) {
        const select = page.locator(selector);
        assert.equal(await select.count(), 1, `${path} must render ${selector}.`);
        assert.equal(await select.isVisible(), true, `${path} must visibly retain ${selector}.`);
        const box = await select.boundingBox();
        assert.ok(box && box.width >= 44 && box.height >= 44, `${path} must keep ${selector} at least 44×44.`);
      }
      assert.equal(await page.locator('header .ac-version').isHidden(), true, `${path} must hide the version pill on mobile.`);
      assert.equal(await page.locator('header .social-icons').isHidden(), true, `${path} must hide GitHub social icons on mobile.`);
      const headerGeometry = await page.evaluate(() => {
        const selectors = [
          '.ac-site-title',
          '.ac-header-search button[data-open-modal]',
          '.ac-docs-link',
          'starlight-theme-select select',
          'starlight-lang-select select',
          'header button:not([data-open-modal])',
        ];
        const elements = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]).filter((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        });
        return {
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          elements: elements.map((element) => {
            const { left, top, right, bottom } = element.getBoundingClientRect();
            return { selector: element.matches('.ac-site-title') ? '.ac-site-title' : element.matches('.ac-docs-link') ? '.ac-docs-link' : element.matches('select') ? element.closest('starlight-theme-select') ? 'starlight-theme-select select' : 'starlight-lang-select select' : element.matches('[data-open-modal]') ? 'search button' : 'mobile menu button', left, top, right, bottom };
          }),
        };
      });
      assert.ok(headerGeometry.scrollWidth <= headerGeometry.clientWidth + 1, `${path} must not horizontally overflow at 390px.`);
      for (let first = 0; first < headerGeometry.elements.length; first += 1) {
        for (let second = first + 1; second < headerGeometry.elements.length; second += 1) {
          const a = headerGeometry.elements[first];
          const b = headerGeometry.elements[second];
          const overlaps = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
          assert.equal(overlaps, false, `${path} must keep ${a.selector} and ${b.selector} at least 0px apart.`);
        }
      }
    } finally {
      await context.close();
    }
  }
}

/**
 * Verifies that syntax highlighting stays inside the approved monochrome palette instead of
 * accepting a theme-specific rendering accident. The oracle walks every rendered span so a
 * newly introduced token category cannot escape a spot check, while its literals remain
 * independent of the production theme table. JSON categories are mapped from each line's
 * concatenated text back to leaf spans by character offsets: Shiki may serialize a quoted
 * string as quote, body, and quote spans, so only spans inside the quote pair receive the
 * string's semantic colour and weight; the quote spans themselves remain punctuation.
 */
async function assertCodeTokenPalette(browser) {
  const themes = {
    dark: { allowed: [[226, 217, 204], [118, 107, 96], [250, 246, 240], [241, 235, 226], [158, 145, 132]], keyword: [250, 246, 240], string: [241, 235, 226], punctuation: [158, 145, 132], background: [16, 12, 9] },
    light: { allowed: [[59, 51, 44], [158, 145, 132], [24, 19, 16], [39, 33, 28], [118, 107, 96]], keyword: [24, 19, 16], string: [39, 33, 28], punctuation: [118, 107, 96], background: [241, 235, 226] },
  };
  for (const scenario of SCREENSHOTS.filter((entry) => entry.path === '/guides/getting-started/' && entry.viewport.width === 1440)) {
    const { colorScheme, viewport } = scenario; const expected = themes[colorScheme];
    const context = await browser.newContext({ colorScheme, viewport }); const page = await context.newPage();
    try {
      await page.goto(pageUrl('/guides/getting-started/'), { waitUntil: 'networkidle' }); await waitForFonts(page);
      const tokens = await page.$$eval('.expressive-code pre span', (spans) => spans.map((span) => ({ text: span.textContent, color: getComputedStyle(span).color, weight: Number(getComputedStyle(span).fontWeight) })));
      assert.ok(tokens.length > 0, `${colorScheme} guide must contain highlighted spans.`);
      for (const token of tokens) assert.ok(expected.allowed.some((color) => color.join(',') === rgbChannels(token.color).join(',')), `${colorScheme} token ${JSON.stringify(token.text)} must use the approved palette.`);
      for (const command of ['npx', 'npm']) {
        const commandTokens = tokens.filter((token) => token.text?.trim() === command);
        assert.ok(commandTokens.length > 0, `${colorScheme} guide must render ${command} tokens.`);
        for (const token of commandTokens) { assert.deepEqual(rgbChannels(token.color), expected.keyword); assert.ok(token.weight >= 700); }
      }
      const json = await page.$$eval('.expressive-code pre', (pres) => pres.map((pre) => ({ text: pre.textContent, background: getComputedStyle(pre).backgroundColor })));
      const jsonBlock = json.find((block) => block.text.includes('"') && block.text.includes(':')); assert.ok(jsonBlock, 'The guide must include a JSON code block.');
      const jsonTokens = await page.evaluate(() => {
        const pre = [...document.querySelectorAll('.expressive-code pre')].find((entry) => entry.textContent?.includes('"') && entry.textContent?.includes(':'));
        if (!pre) throw new Error('The guide needs a JSON code block.');
        const token = (span) => ({ text: span.textContent ?? '', color: getComputedStyle(span).color, weight: Number(getComputedStyle(span).fontWeight) });
        const keys = []; const values = []; const punctuation = [];
        for (const line of pre.querySelectorAll('.ec-line .code')) {
          const leaves = [...line.querySelectorAll('span')].filter((span) => !span.querySelector('span'));
          let offset = 0;
          const spans = leaves.map((span) => {
            const text = span.textContent ?? '';
            const entry = { ...token(span), start: offset, end: offset + text.length };
            offset = entry.end;
            return entry;
          });
          const text = spans.map((span) => span.text).join('');
          const strings = [...text.matchAll(/"(?:\\.|[^"\\])*"/g)].map((match) => {
            const start = match.index ?? 0; const end = start + match[0].length;
            const after = text.slice(end); const before = text.slice(0, start);
            return { start, end, kind: /^\s*:/.test(after) ? 'key' : /:\s*$/.test(before) ? 'value' : null };
          }).filter((entry) => entry.kind);
          for (const span of spans) {
            const category = strings.find((entry) => span.start < entry.end - 1 && entry.start + 1 < span.end)?.kind;
            if (category === 'key') keys.push(span);
            else if (category === 'value') values.push(span);
            if (/^[,:{}"]+$/.test(span.text.replace(/\s/g, ''))) punctuation.push(span);
          }
        }
        return { keys, values, punctuation };
      });
      assert.ok(jsonTokens.keys.length > 0, 'The JSON block must expose key string spans.');
      assert.ok(jsonTokens.values.length > 0, 'The JSON block must expose value string spans.');
      assert.ok(jsonTokens.punctuation.length > 0, 'The JSON block must expose punctuation spans.');
      for (const token of jsonTokens.keys) { assert.deepEqual(rgbChannels(token.color), expected.keyword); assert.ok(token.weight >= 700); }
      for (const token of jsonTokens.values) assert.deepEqual(rgbChannels(token.color), expected.string);
      for (const token of jsonTokens.punctuation) { assert.deepEqual(rgbChannels(token.color), expected.punctuation); assert.ok(token.weight < 700); }
      for (const block of json) assert.deepEqual(rgbChannels(block.background), expected.background);
    } finally { await context.close(); }
  }
}

/**
 * Checks shared document surfaces over every rendered match, which makes the test sensitive to
 * generated headings, table rows, and localized sidebar labels rather than only their first
 * instance. The fallback heading is a temporary clone measured and removed in the page context,
 * preserving the same non-persistent DOM contract as the frame variants.
 */
async function assertDocumentationSurfaces(browser) {
  for (const scenario of SCREENSHOTS.filter((entry) => entry.path.endsWith('/guides/getting-started/'))) {
    const { path, colorScheme, viewport } = scenario;
    const context = await browser.newContext({ colorScheme, viewport }); const page = await context.newPage();
    try {
      await page.goto(pageUrl(path), { waitUntil: 'networkidle' }); await waitForFonts(page);
      if (viewport.width === 390) { await openDocumentationMenu(page); assert.equal(await page.locator('.sidebar-pane').isVisible(), true, `${scenario.name} must open the documentation drawer.`); }
      const values = await page.evaluate(() => { const probe = document.createElement('i'); probe.style.color = 'var(--sl-color-gray-3)'; document.body.append(probe); const gray3 = getComputedStyle(probe).color; probe.style.color = 'var(--sl-color-hairline)'; const hairline = getComputedStyle(probe).color; probe.remove(); const labels = [...document.querySelectorAll('.ac-sidebar summary .large')].map((element) => { const style = getComputedStyle(element); return { text: element.textContent, size: style.fontSize, weight: style.fontWeight, family: style.fontFamily, spacing: parseFloat(style.letterSpacing), transform: style.textTransform, color: style.color }; }); const headings = [...document.querySelectorAll('.sl-heading-wrapper.level-h2')].map((element) => { const style = getComputedStyle(element); const h2 = element.querySelector(':scope > h2'); const h2Style = h2 && getComputedStyle(h2); return { width: element.getBoundingClientRect().width, articleWidth: element.closest('.sl-markdown-content')?.getBoundingClientRect().width, borderWidth: style.borderTopWidth, borderStyle: style.borderTopStyle, borderColor: style.borderTopColor, padding: style.paddingTop, margin: style.marginTop, h2: h2Style && { border: h2Style.borderTopWidth, padding: h2Style.paddingTop, margin: h2Style.marginTop } }; }); return { gray3, hairline, labels, headings }; });
      assert.ok(values.labels.length >= 2); for (const label of values.labels) { assert.equal(label.size, '11px'); assert.equal(label.weight, '500'); assert.match(label.family, /mono/i); assertWithinTolerance(label.spacing, 1.32, 0.05, 'Sidebar label letter spacing'); assert.equal(label.transform, 'uppercase'); assert.deepEqual(rgbChannels(label.color), rgbChannels(values.gray3)); }
      assert.deepEqual(values.labels.map((label) => label.text), ['Guides', 'Reference']);
      if (!path.startsWith('/zh-cn/')) { assert.ok(values.headings.length > 0); for (const heading of values.headings) { assert.equal(heading.borderWidth, '1px'); assert.equal(heading.borderStyle, 'solid'); assert.deepEqual(rgbChannels(heading.borderColor), rgbChannels(values.hairline)); assert.equal(heading.padding, '28px'); assert.equal(heading.margin, '40px'); assertWithinTolerance(heading.width, heading.articleWidth, 1, 'Heading wrapper width'); assert.deepEqual(heading.h2, { border: '0px', padding: '0px', margin: '0px' }); } const fallback = await page.evaluate(() => { const article = document.querySelector('.sl-markdown-content'); const source = article?.querySelector('h2'); if (!article || !source) throw new Error('A fallback heading requires a markdown article h2.'); const clone = source.cloneNode(true); article.append(clone); const style = getComputedStyle(clone); const result = { border: style.borderTopWidth, style: style.borderTopStyle, color: style.borderTopColor, padding: style.paddingTop, margin: style.marginTop }; clone.remove(); return result; }); assert.deepEqual({ border: fallback.border, style: fallback.style, padding: fallback.padding, margin: fallback.margin }, { border: '1px', style: 'solid', padding: '28px', margin: '40px' }); assert.deepEqual(rgbChannels(fallback.color), rgbChannels(values.hairline)); }
    } finally { await context.close(); }
  }
  for (const scenario of SCREENSHOTS.filter((entry) => entry.path.endsWith('/reference/cli/'))) { const { path, colorScheme, viewport } = scenario; const context = await browser.newContext({ colorScheme, viewport }); const page = await context.newPage(); try { await page.goto(pageUrl(path), { waitUntil: 'networkidle' }); const table = await page.evaluate(() => { const probe = (property) => { const element = document.createElement('i'); element.style.color = `var(${property})`; document.body.append(element); const color = getComputedStyle(element).color; element.remove(); return color; }; const padding = (style) => ({ top: style.paddingTop, right: style.paddingRight, bottom: style.paddingBottom, left: style.paddingLeft }); return [...document.querySelectorAll('.sl-markdown-content table')].map((entry) => ({ fontSize: getComputedStyle(entry).fontSize, gray3: probe('--sl-color-gray-3'), gray4: probe('--sl-color-gray-4'), hairline: probe('--sl-color-hairline'), white: probe('--sl-color-white'), headers: [...entry.querySelectorAll('th')].map((cell) => { const style = getComputedStyle(cell); return { size: style.fontSize, weight: style.fontWeight, family: style.fontFamily, spacing: parseFloat(style.letterSpacing), transform: style.textTransform, padding: padding(style), borderWidth: style.borderBottomWidth, borderStyle: style.borderBottomStyle, borderColor: style.borderBottomColor, first: cell.matches(':first-child'), last: cell.matches(':last-child'), color: style.color }; }), cells: [...entry.querySelectorAll('td')].map((cell) => { const style = getComputedStyle(cell); const codes = [...cell.querySelectorAll('code')].map((code) => ({ color: getComputedStyle(code).color, whiteSpace: getComputedStyle(code).whiteSpace })); return { padding: padding(style), lineHeight: style.lineHeight, verticalAlign: style.verticalAlign, borderWidth: style.borderBottomWidth, borderStyle: style.borderBottomStyle, borderColor: style.borderBottomColor, first: cell.matches(':first-child'), last: cell.matches(':last-child'), color: style.color, codes }; }) })); }); assert.ok(table.length > 0); for (const entry of table) { assert.equal(entry.fontSize, '13px'); for (const header of entry.headers) { assert.equal(header.size, '11px'); assert.equal(header.weight, '500'); assert.match(header.family, /mono/i); assertWithinTolerance(header.spacing, 1.32, 0.05, 'Table heading letter spacing'); assert.equal(header.transform, 'uppercase'); assert.deepEqual(header.padding, { top: '9.6px', right: header.last ? '0px' : '12px', bottom: '9.6px', left: header.first ? '0px' : '12px' }); assert.equal(header.borderWidth, '1px'); assert.equal(header.borderStyle, 'solid'); assert.deepEqual(rgbChannels(header.borderColor), rgbChannels(entry.gray4)); assert.deepEqual(rgbChannels(header.color), rgbChannels(entry.gray3)); } for (const cell of entry.cells) { assert.deepEqual(cell.padding, { top: '11.2px', right: cell.last ? '0px' : '12px', bottom: '11.2px', left: cell.first ? '0px' : '12px' }); assert.equal(cell.lineHeight, '19.5px'); assert.equal(cell.verticalAlign, 'top'); assert.equal(cell.borderWidth, '1px'); assert.equal(cell.borderStyle, 'solid'); assert.deepEqual(rgbChannels(cell.borderColor), rgbChannels(entry.hairline)); if (cell.first) { assert.deepEqual(rgbChannels(cell.color), rgbChannels(entry.white)); for (const code of cell.codes) assert.deepEqual(rgbChannels(code.color), rgbChannels(entry.white)); } for (const code of cell.codes) assert.equal(code.whiteSpace, 'nowrap'); } } } finally { await context.close(); } }
}

/**
 * Exercises all frame variants without changing documentation content. The two unavailable
 * variants are cloned with their enclosing expressive-code wrapper, because frame styling relies
 * on that ancestor; every temporary wrapper is removed after measurement. Geometry permits one
 * pixel of browser rounding, while the COPY button must be wider than its height and remain
 * compact rather than being mistaken for the plugin's square icon geometry; first-line clearance is
 * guaranteed by inline-end padding at least eight pixels wider than the COPY button, with rect
 * non-intersection additionally checked when the line fits within its pre. A line that overflows
 * its pre can scroll underneath the floating button, so rectangle non-intersection cannot hold
 * there and the padding-clearance contract is the only applicable assertion.
 * The pseudo-element oracle reads generated TERMINAL and COPY labels from computed styles because
 * their DOM nodes are intentionally absent. The TERMINAL label must retain its line-height-sized
 * box rather than the plugin's fixed-size dot geometry, while its inset remains content-driven.
 */
async function assertCodeFrameVariants(browser) {
  for (const scenario of SCREENSHOTS.filter((entry) => entry.path === '/guides/getting-started/' || entry.path === '/ja/guides/getting-started/')) {
    const { colorScheme, viewport } = scenario; const context = await browser.newContext({ colorScheme, viewport }); const page = await context.newPage();
    try {
      await page.goto(pageUrl(scenario.path), { waitUntil: 'networkidle' }); await waitForFonts(page);
      const ids = await page.evaluate(() => {
        const source = document.querySelector('.expressive-code .frame'); if (!source) throw new Error('The guide needs a code frame.');
        const targets = [...document.querySelectorAll('.expressive-code .frame')].map((frame) => ({ frame, cloned: false, terminal: frame.classList.contains('is-terminal'), titled: frame.classList.contains('has-title') }));
        for (const variant of [{ terminal: true, title: true }, { terminal: false, title: true }]) {
          if (targets.some((target) => target.terminal === variant.terminal && target.titled === variant.title)) continue;
          const wrapper = source.closest('.expressive-code')?.cloneNode(true); const frame = wrapper?.querySelector('.frame'); if (!wrapper || !frame) throw new Error('Frame clones require an expressive-code wrapper.'); frame.classList.toggle('is-terminal', variant.terminal); frame.classList.toggle('has-title', variant.title);
          let title = frame.querySelector('.header .title'); if (!title) { title = document.createElement('div'); title.className = 'title'; frame.querySelector('.header')?.append(title); }
          title.textContent = 'example.txt'; wrapper.dataset.acTemporaryFrame = 'true'; document.body.append(wrapper); targets.push({ frame, cloned: true, wrapper, terminal: variant.terminal, titled: variant.title });
        }
        return targets.map((entry, index) => { entry.frame.dataset.acFrameCase = String(index); return String(index); });
      });
      const caseCounts = await page.evaluate(() => [...document.querySelectorAll('[data-ac-frame-case]')].reduce((counts, frame) => { const key = `${frame.classList.contains('is-terminal')}:${frame.classList.contains('has-title')}`; counts[key] = (counts[key] ?? 0) + 1; return counts; }, {}));
      for (const key of ['true:false', 'true:true', 'false:true', 'false:false']) assert.ok(caseCounts[key] >= 1, `The frame oracle must exercise ${key}.`);
      const copyDimensions = await page.evaluate(() => [...document.querySelectorAll('[data-ac-frame-case] .copy button')].map((button) => { const style = getComputedStyle(button); const rect = button.getBoundingClientRect(); return { width: rect.width, height: rect.height, computedWidth: style.width }; }));
      for (const dimensions of copyDimensions) { assert.ok(dimensions.width > dimensions.height, 'COPY button must not be square'); assert.notEqual(dimensions.computedWidth, '28px'); assert.ok(dimensions.width < 120, 'COPY button width must remain compact'); }
      for (const id of ids) {
        const locator = page.locator(`[data-ac-frame-case="${id}"]`); const button = locator.locator('.copy button');
        const normal = await page.evaluate((caseId) => { const frame = document.querySelector(`[data-ac-frame-case="${caseId}"]`); if (!frame) throw new Error('Frame case disappeared.'); const probe = document.createElement('i'); probe.style.color = 'var(--ac-code-bg)'; document.body.append(probe); const background = getComputedStyle(probe).color; probe.remove(); const header = frame.querySelector('.header'); const title = frame.querySelector('.header .title'); const button = frame.querySelector('.copy button'); const code = frame.querySelector('.ec-line .code'); const pre = frame.querySelector('pre'); if (!header || !button || !code || !pre) throw new Error('Frame case must have a header, COPY button, and first code line.'); const range = document.createRange(); range.selectNodeContents(code); const textRect = range.getBoundingClientRect(); const style = getComputedStyle(button); const headerStyle = getComputedStyle(header); const titleStyle = title && getComputedStyle(title); const titleRect = title?.getBoundingClientRect(); const rect = button.getBoundingClientRect(); const copy = button.closest('.copy'); return { terminal: frame.classList.contains('is-terminal'), titled: frame.classList.contains('has-title'), header: { display: headerStyle.display, height: header.getBoundingClientRect().height, before: getComputedStyle(header, '::before').content, after: getComputedStyle(header, '::after').content }, title: titleStyle && { display: titleStyle.display, size: titleStyle.fontSize, family: titleStyle.fontFamily, color: titleStyle.color, visible: titleRect !== undefined && titleStyle.display !== 'none' && titleRect.width > 0 && titleRect.height > 0 }, copy: { height: rect.height, width: rect.width, opacity: style.opacity, background: style.backgroundColor, border: style.borderColor, borderWidth: style.borderWidth, borderStyle: style.borderStyle, before: getComputedStyle(button, '::before').content, after: getComputedStyle(button, '::after').content, inner: button.querySelector('div') ? getComputedStyle(button.querySelector('div')).display : null, title: button.getAttribute('title'), copied: button.getAttribute('data-copied'), feedback: copy?.querySelector(':scope > [aria-live]')?.getAttribute('aria-live') ?? null, clearance: parseFloat(getComputedStyle(code).paddingInlineEnd), buttonWidth: rect.width, lineFits: pre.scrollWidth <= pre.clientWidth, intersects: rect.left < textRect.right && textRect.left < rect.right && rect.top < textRect.bottom && textRect.top < rect.bottom }, background }; }, id);
        const pseudo = await page.evaluate((caseId) => { const frame = document.querySelector(`[data-ac-frame-case="${caseId}"]`); const header = frame?.querySelector('.header'); const button = frame?.querySelector('.copy button'); if (!header || !button) throw new Error('D4 pseudo-element targets disappeared.'); const read = (element, pseudo) => { const style = getComputedStyle(element, pseudo); return { content: style.content, family: style.fontFamily, size: style.fontSize, weight: style.fontWeight, lineHeight: style.lineHeight, spacing: parseFloat(style.letterSpacing), transform: style.textTransform, color: style.color, position: style.position, inset: style.inset, width: style.width, height: style.height, mask: style.mask, webkitMask: style.webkitMask, opacity: style.opacity, background: style.background, backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage, margin: style.margin }; }; const headerStyle = getComputedStyle(header); return { header: { display: headerStyle.display, align: headerStyle.alignItems, justify: headerStyle.justifyContent, before: read(header, '::before') }, copy: { after: read(button, '::after') } }; }, id);
        const gray3 = await page.evaluate(() => { const probe = document.createElement('i'); probe.style.color = 'var(--sl-color-gray-3)'; document.body.append(probe); const value = getComputedStyle(probe).color; probe.remove(); return value; });
        if (normal.terminal || normal.titled) { assert.equal(pseudo.header.display, 'flex'); assert.equal(pseudo.header.align, 'center'); assert.equal(pseudo.header.justify, 'flex-start'); }
        if (normal.terminal && !normal.titled) { const label = pseudo.header.before; assert.equal(label.content, '"TERMINAL"'); assert.match(label.family, /mono/i); assert.equal(label.size, '11px'); assert.equal(label.weight, '500'); assert.equal(label.lineHeight, '13.2px'); assertWithinTolerance(label.spacing, 1.32, 0.05, 'TERMINAL letter spacing'); assert.equal(label.transform, 'uppercase'); assert.deepEqual(rgbChannels(label.color), rgbChannels(gray3)); assert.equal(label.position, 'static'); assert.equal(label.inset, 'auto'); assertWithinTolerance(parseFloat(label.height), 13.2, 1, 'TERMINAL label height'); assert.ok(parseFloat(label.width) > parseFloat(label.height), 'TERMINAL label must not use a fixed dot box'); assert.equal(label.mask, 'none'); assert.equal(label.webkitMask, 'none'); assert.equal(label.opacity, '1'); assert.equal(label.backgroundImage, 'none'); assert.equal(label.backgroundColor, 'rgba(0, 0, 0, 0)'); assert.equal(label.margin, '0px'); }
        const copyLabel = pseudo.copy.after; assert.equal(copyLabel.content, '"COPY"'); assert.match(copyLabel.family, /mono/i); assert.equal(copyLabel.size, '11px'); assert.equal(copyLabel.weight, '500'); assert.equal(copyLabel.lineHeight, '11px'); assertWithinTolerance(copyLabel.spacing, 0.88, 0.05, 'COPY letter spacing'); assert.equal(copyLabel.transform, 'uppercase'); assert.deepEqual(rgbChannels(copyLabel.color), rgbChannels(gray3)); assert.equal(copyLabel.position, 'static'); assert.equal(copyLabel.inset, 'auto'); assert.equal(copyLabel.mask, 'none'); assert.equal(copyLabel.webkitMask, 'none'); assert.equal(copyLabel.opacity, '1', 'COPY pseudo-element must be fully opaque.'); assert.equal(copyLabel.backgroundImage, 'none'); assert.equal(copyLabel.backgroundColor, 'rgba(0, 0, 0, 0)'); assert.equal(copyLabel.margin, '0px');
        await button.hover();
        await page.waitForFunction((caseId) => { const button = document.querySelector(`[data-ac-frame-case="${caseId}"] .copy button`); if (!button) return false; const probe = document.createElement('i'); probe.style.color = 'var(--sl-color-gray-1)'; document.body.append(probe); const text = getComputedStyle(probe).color; probe.style.color = 'var(--sl-color-gray-4)'; const border = getComputedStyle(probe).color; probe.remove(); const style = getComputedStyle(button); return getComputedStyle(button, '::after').color === text && style.borderColor === border; }, id);
        const hovered = await page.evaluate((caseId) => { const button = document.querySelector(`[data-ac-frame-case="${caseId}"] .copy button`); if (!button) throw new Error('COPY button disappeared.'); const style = getComputedStyle(button); return { text: getComputedStyle(button, '::after').color, border: style.borderColor, background: style.backgroundColor }; }, id);
        assert.equal(normal.header.after, 'none'); assertWithinTolerance(normal.copy.height, 28, 1, 'Copy button height'); assert.ok(normal.copy.width > 0); assert.equal(normal.copy.opacity, '1'); assert.deepEqual(rgbChannels(normal.copy.background), rgbChannels(normal.background)); assert.deepEqual(rgbChannels(normal.copy.border), rgbChannels(await page.evaluate(() => { const probe = document.createElement('i'); probe.style.color = 'var(--sl-color-hairline)'; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; }))); assert.equal(normal.copy.before, 'none'); assert.equal(normal.copy.after, '"COPY"'); assert.equal(normal.copy.inner, 'none'); assert.equal(normal.copy.borderWidth, '1px'); assert.equal(normal.copy.borderStyle, 'solid'); const expectedCopyLabels = scenario.path.startsWith('/ja/') ? { title: 'クリップボードにコピー', copied: 'コピーしました！' } : { title: 'Copy to clipboard', copied: 'Copied!' }; assert.equal(normal.copy.title, expectedCopyLabels.title); assert.equal(normal.copy.copied, expectedCopyLabels.copied); assert.equal(normal.copy.feedback, 'polite'); assert.ok(normal.copy.clearance >= normal.copy.buttonWidth + 8, 'first code line must clear the COPY button'); const { intersects } = normal.copy; if (normal.copy.lineFits) assert.equal(intersects, false, 'COPY button must not overlap a fitting first line'); assert.deepEqual(rgbChannels(hovered.background), rgbChannels(normal.background)); assert.deepEqual(rgbChannels(hovered.text), rgbChannels(await page.evaluate(() => { const probe = document.createElement('i'); probe.style.color = 'var(--sl-color-gray-1)'; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; }))); assert.deepEqual(rgbChannels(hovered.border), rgbChannels(await page.evaluate(() => { const probe = document.createElement('i'); probe.style.color = 'var(--sl-color-gray-4)'; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; })));
        if (!normal.terminal && !normal.titled) { assert.equal(normal.header.display, 'none'); assert.equal(normal.header.height, 0); } else { assert.notEqual(normal.header.display, 'none'); assertWithinTolerance(normal.header.height, 36, 1, 'Visible code frame header height'); }
        if (normal.terminal && !normal.titled) { assert.equal(normal.header.before, '"TERMINAL"'); assert.equal(normal.title?.display, 'none'); } else if (normal.terminal) assert.equal(normal.header.before, 'none');
        if (!normal.terminal && normal.titled) { assert.notEqual(normal.title?.display, 'none'); assert.equal(normal.title?.visible, true); }
        if (normal.terminal && normal.titled) { assert.notEqual(normal.title?.display, 'none'); assert.equal(normal.title?.size, '13px'); assert.match(normal.title?.family ?? '', /mono/i); assert.deepEqual(rgbChannels(normal.title?.color ?? ''), rgbChannels(await page.evaluate(() => { const probe = document.createElement('i'); probe.style.color = 'var(--sl-color-gray-1)'; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; }))); }
      }
      await page.evaluate(() => { document.querySelectorAll('[data-ac-temporary-frame="true"]').forEach((entry) => entry.remove()); document.querySelectorAll('[data-ac-frame-case]').forEach((entry) => entry.removeAttribute('data-ac-frame-case')); });
    } finally { await context.close(); }
  }
}

/**
 * Keeps document measurements tied to the approved layout contract rather than browser serialization details.
 * A one-pixel allowance covers fractional-layout serialization, two pixels covers comparing two
 * independently rounded gutters, and letter spacing accepts five hundredths of a pixel because
 * font shaping exposes a fractional computed value.
 */
function assertWithinTolerance(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected} ± ${tolerance}, received ${actual}`);
}

/**
 * Confirms a narrow code block remains readable through its own scroll container instead of
 * relying on clipping or page-level overflow. Assigning scrollLeft is a behavioral probe: it
 * proves that the final portion of the command can be reached without mutating durable content.
 */
async function assertCodeBlockScroll(browser) {
  for (const scenario of SCREENSHOTS.filter((entry) => entry.path === '/reference/cli/' && entry.colorScheme === 'dark')) {
    const { viewport } = scenario; const context = await browser.newContext({ colorScheme: scenario.colorScheme, viewport }); const page = await context.newPage();
    try { await page.goto(pageUrl('/reference/cli/'), { waitUntil: 'networkidle' }); const measure = await page.evaluate(() => { const pre = [...document.querySelectorAll('.expressive-code pre[data-language="text"]')].find((entry) => entry.textContent?.includes('Usage: ambercast')); if (!pre) throw new Error('The CLI reference needs its Usage: ambercast text code block.'); pre.scrollLeft = pre.scrollWidth; return { scrollWidth: pre.scrollWidth, clientWidth: pre.clientWidth, scrollLeft: pre.scrollLeft, overflow: getComputedStyle(pre).overflowX, pageWidth: document.documentElement.scrollWidth, clientPageWidth: document.documentElement.clientWidth }; }); if (viewport.width === 390) { assert.ok(measure.scrollWidth > measure.clientWidth); assert.ok(['auto', 'scroll'].includes(measure.overflow)); assertWithinTolerance(measure.scrollLeft, measure.scrollWidth - measure.clientWidth, 1, 'Code block final scroll position'); } assert.ok(measure.pageWidth <= measure.clientPageWidth + 1); } finally { await context.close(); }
  }
}

/**
 * Measures the wide document layout as a geometric symmetry contract. It compares the article's
 * two free gutters, the fixed table-of-contents column, and the viewport edge so a compensating
 * offset in one region cannot hide a layout regression in another. At the boundary widths, the
 * main pane is 560px wide and cannot sustain a 3rem gap, so the minimum gap is checked only at
 * the 1440px and 2000px acceptance widths.
 */
async function assertDocumentColumnSymmetry(browser) {
  for (const scenario of SCREENSHOTS.filter((entry) => ['/guides/introduction/', '/ja/guides/introduction/'].includes(entry.path))) {
    const { viewport } = scenario; const context = await browser.newContext({ colorScheme: scenario.colorScheme, viewport }); const page = await context.newPage();
    try { await page.goto(pageUrl(scenario.path), { waitUntil: 'networkidle' }); const geometry = await page.evaluate(() => { const sidebar = document.querySelector('.sidebar-pane'); const contents = [...document.querySelectorAll('.main-pane .content-panel .sl-container')]; const toc = document.querySelector('.right-sidebar-container'); const inner = document.querySelector('.right-sidebar-panel .sl-container'); if (!sidebar || !toc || !inner || contents.length === 0) throw new Error('The three-column document layout is incomplete.'); return { sidebarRight: sidebar.getBoundingClientRect().right, content: contents.map((entry) => { const rect = entry.getBoundingClientRect(); return { left: rect.left, right: rect.right }; }), toc: toc.getBoundingClientRect().toJSON(), innerRight: inner.getBoundingClientRect().right, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }; }); assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1); if (viewport.width >= 1152) { for (const content of geometry.content) { assertWithinTolerance(content.left, geometry.content[0].left, 1, 'All content columns share a left edge'); assertWithinTolerance(content.right, geometry.content[0].right, 1, 'All content columns share a right edge'); } const content = geometry.content[0]; assertWithinTolerance((content.left - geometry.sidebarRight) - (geometry.toc.left - content.right), 0, 2, 'Document gutters must be symmetric'); assertWithinTolerance(geometry.toc.right, geometry.clientWidth, 1, 'TOC right edge'); assertWithinTolerance(geometry.toc.width, 272, 1, 'TOC width'); assert.ok(geometry.innerRight <= geometry.clientWidth); if (viewport.width >= 1440) assert.ok(geometry.toc.left - content.right >= 48); } else assert.notEqual(Math.round(geometry.toc.width), 272); } finally { await context.close(); }
  }
}

/**
 * Opens the responsive documentation drawer only when the sidebar is otherwise unavailable.
 * The helper keeps each viewport assertion focused on its visible navigation surface and does
 * not assume a particular animation implementation.
 */
async function openDocumentationMenu(page) {
  const menu = page.locator('button.sl-menu-button[popovertarget="starlight__sidebar"]').first();
  assert.equal(await menu.count(), 1, 'A document page must render Starlight’s mobile menu control.');
  if (!await page.locator('#starlight__sidebar:popover-open').count()) await menu.click();
  await page.waitForFunction(() => document.querySelector('#starlight__sidebar')?.matches(':popover-open') === true);
  await page.locator('.sidebar-pane').waitFor({ state: 'visible' });
}

async function captureScreenshots(browser) {
  await mkdir(SCREENSHOT_DIRECTORY, { recursive: true });

  for (const screenshot of SCREENSHOTS) {
    const context = await browser.newContext({
      colorScheme: screenshot.colorScheme,
      viewport: screenshot.viewport,
    });
    const page = await context.newPage();

    try {
      await page.goto(pageUrl(screenshot.path), { waitUntil: 'networkidle' });
      await waitForFonts(page);
      await assertBasePath(page);
      const hasHorizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      assert.equal(hasHorizontalOverflow, false, `${screenshot.name} must not overflow horizontally.`);
      await page.screenshot({
        path: resolve(SCREENSHOT_DIRECTORY, `${screenshot.name}.png`),
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  }
}

async function main() {
  port = await findAvailablePort();
  origin = `http://${HOST}:${port}`;
  const preview = startPreview();
  let browser;

  try {
    await waitForPreview(preview);
    await assertServerRenderedFallback();
    browser = await chromium.launch({ headless: true });
    await assertLocaleRoots(browser);
    await assertInteractiveBehavior(browser);
    for (const key of KEYBOARD_ACTIVATION_KEYS) {
      await assertGenerateKeyboardActivation(browser, key);
      await assertRunKeyboardActivation(browser, key);
      await assertResetKeyboardActivation(browser, key);
    }
    await assertResetCancelsGeneration(browser);
    await assertResetCancelsRun(browser);
    await assertGenerationFrameTiming(browser);
    await assertReducedMotion(browser);
    await assertHeaderV13(browser);
    await assertComputedStyleTable(browser);
    await assertGutterClearance(browser);
    await assertLightThemeFlat(browser);
    await assertResponsiveAndDocumentationInvariants(browser);
    await assertApprovedCopyAndNoClipping(browser);
    await assertSsrClientBuilderEquality(browser);
    await assertDocumentationSurfaces(browser);
    await assertCodeTokenPalette(browser);
    await assertCodeFrameVariants(browser);
    await assertCodeBlockScroll(browser);
    await assertDocumentColumnSymmetry(browser);
    await captureBoundaryAndPhaseScreenshots(browser);
    await captureScreenshots(browser);
  } finally {
    try {
      await browser?.close();
    } finally {
      await stopPreview(preview);
    }
  }
}

main().then(
  () => {
    console.log(`visual-and-behavior: screenshots saved to ${SCREENSHOT_DIRECTORY}`);
  },
  (error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  },
);
