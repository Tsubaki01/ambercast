#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
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
const RESET_SETTLE_BUFFER_MS = 100;
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

const APPROVED_EXTERNAL_SITE_URLS = [
  { origin: 'https://tsubaki01.github.io', pathnamePrefix: '/ambercast/' },
];

const APPROVED_EXTERNAL_ANCHOR_URLS = [
  ...APPROVED_EXTERNAL_SITE_URLS,
  { origin: 'https://playwright.dev', pathname: '/' },
  { origin: 'https://docs.claude.com', pathname: '/en/docs/claude-code' },
  { origin: 'https://github.com', pathname: '/openai/codex' },
  { origin: 'https://github.com', pathname: '/Tsubaki01/ambercast' },
  { origin: 'https://github.com', pathname: '/Tsubaki01/ambercast/blob/main/CHANGELOG.md' },
  { origin: 'https://github.com', pathnamePrefix: '/Tsubaki01/ambercast/edit/main/website/' },
  { origin: 'https://www.npmjs.com', pathname: '/package/ambercast' },
];

const SCREENSHOTS = [
  { name: 'landing-1440-dark', path: '/', viewport: { width: 1440, height: 1100 }, colorScheme: 'dark' },
  { name: 'landing-1440-light', path: '/', viewport: { width: 1440, height: 1100 }, colorScheme: 'light' },
  { name: 'landing-390-dark', path: '/', viewport: { width: 390, height: 844 }, colorScheme: 'dark' },
  { name: 'landing-1440-dark-ja', path: '/ja/', viewport: { width: 1440, height: 1100 }, colorScheme: 'dark' },
  { name: 'landing-1440-light-ja', path: '/ja/', viewport: { width: 1440, height: 1100 }, colorScheme: 'light' },
  { name: 'landing-390-dark-ja', path: '/ja/', viewport: { width: 390, height: 844 }, colorScheme: 'dark' },
  { name: 'landing-1440-dark-zh-cn', path: '/zh-cn/', viewport: { width: 1440, height: 1100 }, colorScheme: 'dark' },
  { name: 'landing-1440-light-zh-cn', path: '/zh-cn/', viewport: { width: 1440, height: 1100 }, colorScheme: 'light' },
  { name: 'landing-390-dark-zh-cn', path: '/zh-cn/', viewport: { width: 390, height: 844 }, colorScheme: 'dark' },
  { name: 'guide-dark', path: '/guides/getting-started/', viewport: { width: 1440, height: 1100 }, colorScheme: 'dark' },
  { name: 'guide-light', path: '/guides/getting-started/', viewport: { width: 1440, height: 1100 }, colorScheme: 'light' },
  { name: 'guide-ja', path: '/ja/guides/getting-started/', viewport: { width: 1440, height: 1100 }, colorScheme: 'dark' },
  { name: 'reference-dark', path: '/reference/cli/', viewport: { width: 1440, height: 1100 }, colorScheme: 'dark' },
  { name: 'reference-light', path: '/reference/cli/', viewport: { width: 1440, height: 1100 }, colorScheme: 'light' },
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
  assert.ok(generateTag, 'The server-rendered Generate button must exist.');
  assert.match(generateTag, /\sdisabled(?:\s|>)/, 'Generate must be disabled in the fallback done state.');
  assert.ok(runTag, 'The server-rendered Run button must exist.');
  assert.match(runTag, /\sdisabled(?:\s|>)/, 'Run again must be disabled in the fallback done state until the adapter attaches.');
  assert.ok(resetTag, 'The server-rendered Reset button must exist.');
  assert.match(resetTag, /\sdisabled(?:\s|>)/, 'Reset must be disabled in the fallback done state until the adapter attaches.');
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
  await page.evaluate(() => Promise.allSettled([...document.fonts].map((font) => font.load())));

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
    await assertLiveRegion(page, status);
    assert.match(await status.ariaSnapshot(), /idle/i);
    const statusNode = await status.elementHandle();
    assert.ok(statusNode, '#demo-status must render a DOM node.');
    await assertPersistentStatusNode(statusNode);

    const foreignRequests = watchForeignRequests(context);

    const generationStartedAt = Date.now();
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
    const generationCompletionDelayMs = Date.now() - generationStartedAt;
    await assertNativeDisabled(generate, true, 'Generate must stay natively disabled in cast.');
    await assertNativeDisabled(run, false, 'Run must become enabled in cast.');
    await assertAnimationName(run, null, 'demo-action-hint-ring', 'Run must show the hint ring when it becomes actionable.');

    const runStartedAt = Date.now();
    await run.click();
    await assertNativeDisabled(generate, true, 'Generate must stay natively disabled in run.');
    await waitForDemoPhase(page, status, statusNode, /(?:replay|cache hit)/i, 'Run did not reach the run state.');
    await assertNativeDisabled(generate, true, 'Generate must stay natively disabled throughout run.');
    await assertPartialTyping(page, '[data-demo-email]', 'mika@example.com', 'Email');
    await assertPartialTyping(page, '[data-demo-password]', '••••••••••', 'Password');
    await assertCounters(counter, 1, 1);
    await waitForDemoPhase(page, status, statusNode, /exit 0/i, 'Run did not reach the terminal replay state.');
    const runCompletionDelayMs = Date.now() - runStartedAt;
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

    return { generationCompletionDelayMs, runCompletionDelayMs };
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

async function assertResetCancelsGeneration(browser, generationCompletionDelayMs) {
  const { context, page, generate, reset, counter, status } = await openDemoPage(browser);

  try {
    const foreignRequests = watchForeignRequests(context);
    const statusNode = await status.elementHandle();
    assert.ok(statusNode, '#demo-status must render a DOM node.');
    await generate.click();
    await waitForDemoPhase(page, status, statusNode, /generat/i, 'Generate did not reach the gen state before Reset.');
    await reset.click();
    await waitForDemoPhase(page, status, statusNode, /idle/i, 'Reset did not return gen to idle.');
    await assertCounters(counter, 0, 0);
    await sleep(generationCompletionDelayMs + RESET_SETTLE_BUFFER_MS);
    await waitForDemoPhase(page, status, statusNode, /idle/i, 'A stale generation completion resurrected cast after Reset.');
    await assertCounters(counter, 0, 0);
    assertNoForeignRequests(foreignRequests);
  } finally {
    await context.close();
  }
}

async function assertResetCancelsRun(browser, runCompletionDelayMs) {
  const { context, page, generate, run, reset, counter, status } = await openDemoPage(browser);

  try {
    const foreignRequests = watchForeignRequests(context);
    const statusNode = await status.elementHandle();
    assert.ok(statusNode, '#demo-status must render a DOM node.');
    await generate.click();
    await waitForDemoPhase(page, status, statusNode, /cast/i, 'Generate did not prepare run for Reset.');
    await run.click();
    await waitForDemoPhase(page, status, statusNode, /(?:replay|cache hit)/i, 'Run did not reach the run state before Reset.');
    await reset.click();
    await waitForDemoPhase(page, status, statusNode, /idle/i, 'Reset did not return run to idle.');
    await assertCounters(counter, 0, 0);
    await sleep(runCompletionDelayMs + RESET_SETTLE_BUFFER_MS);
    await waitForDemoPhase(page, status, statusNode, /idle/i, 'A stale run completion resurrected done after Reset.');
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
  } finally {
    await context.close();
  }
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
      await page.evaluate(() => Promise.allSettled([...document.fonts].map((font) => font.load())));
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
    const completionDelays = await assertInteractiveBehavior(browser);
    for (const key of KEYBOARD_ACTIVATION_KEYS) {
      await assertGenerateKeyboardActivation(browser, key);
      await assertRunKeyboardActivation(browser, key);
      await assertResetKeyboardActivation(browser, key);
    }
    await assertResetCancelsGeneration(browser, completionDelays.generationCompletionDelayMs);
    await assertResetCancelsRun(browser, completionDelays.runCompletionDelayMs);
    await assertReducedMotion(browser);
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
