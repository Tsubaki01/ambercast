import { demoPlan } from '../data/demo-plan.ts';
import { dispatch, type DemoSnapshot } from './demo-state-machine.ts';

const STRUCTURAL_LINE_DELAY_MS = 90;
const STEP_LINE_DELAY_MS = 230;
const CAST_SETTLE_DELAY_MS = 300;
const RUN_DELAY_MS = 2_400;
const EMAIL_TYPING_DELAY_MS = 22;
const PASSWORD_TYPING_DELAY_MS = 28;

export const PLAN_LINES = [
  { text: '{' },
  { text: `  "schemaVersion": ${demoPlan.schemaVersion},` },
  { text: `  "source": ${JSON.stringify(demoPlan.source)},` },
  { text: '  "steps": [' },
  ...demoPlan.steps.map((step, index) => ({
    text: `    ${JSON.stringify(step)}${index === demoPlan.steps.length - 1 ? '' : ','}`,
    step: index,
  })),
  { text: '  ],' },
  { text: `  "targets": ${JSON.stringify(demoPlan.targets)}` },
  { text: '}' },
] as const;

const GENERATION_FRAME_DELAYS = PLAN_LINES.map((line) => (
  'step' in line ? STEP_LINE_DELAY_MS : STRUCTURAL_LINE_DELAY_MS
));
const GENERATION_DELAY_MS = GENERATION_FRAME_DELAYS.reduce((total, delay) => total + delay, CAST_SETTLE_DELAY_MS);

/**
 * Connects the demo state machine to its persistent Astro markup.
 *
 * The adapter owns timing and reads the motion preference once because neither concern belongs
 * in the synchronous state machine. A reset advances a generation token, so a stale completion
 * from either asynchronous phase cannot resurrect a discarded visual state.
 *
 * @param root - The rendered demo shell containing the controls and status region.
 */
export function attach(root: HTMLElement): void {
  const counter = requiredElement(root, '#demo-counter');
  const promptPanel = requiredElement(root, '#demo-prompt-panel');
  const planPanel = requiredElement(root, '#demo-plan-panel');
  const browserPanel = requiredElement(root, '#demo-browser-panel');
  const status = requiredElement(root, '#demo-status');
  const generate = requiredButton(root, '#demo-generate');
  const run = requiredButton(root, '#demo-run');
  const reset = requiredButton(root, '#demo-reset');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let snapshot: DemoSnapshot = { phase: 'idle', aiCalls: 0, runs: 0 };
  let generationToken = 0;

  const render = () => {
    counter.textContent = `RUNS ${snapshot.runs} · AI CALLS ${snapshot.aiCalls}`;
    promptPanel.innerHTML = promptMarkup();
    planPanel.innerHTML = planMarkup(snapshot.phase);
    browserPanel.innerHTML = browserMarkup(snapshot.phase);
    status.textContent = statusText(snapshot);
    generate.disabled = snapshot.phase !== 'idle';
    run.disabled = snapshot.phase !== 'cast' && snapshot.phase !== 'done';
    reset.disabled = false;
    generate.classList.toggle('demo-action-hint', !generate.disabled);
    run.classList.toggle('demo-action-hint', !run.disabled);
    run.textContent = snapshot.phase === 'done' ? 'Run again ›' : 'Run ›';
  };

  const transition = (event: Parameters<typeof dispatch>[1]) => {
    snapshot = dispatch(snapshot, event);
    render();
  };

  const scheduleCompletion = (event: 'generationComplete' | 'runComplete', delay: number) => {
    const capturedToken = generationToken;
    if (reducedMotion) {
      transition(event);
      return;
    }
    setTimeout(() => {
      if (capturedToken === generationToken) transition(event);
    }, delay);
  };

  generate.addEventListener('click', () => {
    if (snapshot.phase !== 'idle') return;
    transition('generate');
    if (!reducedMotion) {
      const capturedToken = generationToken;
      scheduleGenerationFrames(planPanel, () => capturedToken === generationToken && snapshot.phase === 'gen');
    }
    scheduleCompletion('generationComplete', GENERATION_DELAY_MS);
  });
  run.addEventListener('click', () => {
    if (snapshot.phase !== 'cast' && snapshot.phase !== 'done') return;
    transition('run');
    if (!reducedMotion) {
      const capturedToken = generationToken;
      scheduleRunFrames(browserPanel, planPanel, () => capturedToken === generationToken && snapshot.phase === 'run');
    }
    scheduleCompletion('runComplete', RUN_DELAY_MS);
  });
  reset.addEventListener('click', () => {
    generationToken += 1;
    transition('reset');
  });

  render();
}

function requiredElement(root: HTMLElement, selector: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Demo element is missing: ${selector}`);
  return element;
}

function requiredButton(root: HTMLElement, selector: string): HTMLButtonElement {
  const element = root.querySelector(selector);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Demo button is missing: ${selector}`);
  return element;
}

function promptMarkup(): string {
  const prompt = `# Login

@ambercast-secret {{secrets.password}}

Go to /login.
Fill in the email "mika@example.com" and the password {{secrets.password}}.
Click "Sign in".
Expect to land on the dashboard and see a "Welcome" heading.`;
  return `<header><span>login.test.md</span><span class="demo-pill">prompt</span></header><pre>${prompt}</pre><footer>plain markdown · committed to git</footer>`;
}

function planMarkup(phase: DemoSnapshot['phase']): string {
  if (phase === 'idle') {
    return '<header><span>login.ambercast.plan.json</span><span class="demo-pill">empty</span></header><div class="demo-plan-empty">plan appears here<br>after generate</div><footer>+ login.ambercast.grounding.json</footer>';
  }

  const label = phase === 'gen' ? 'casting · 1 AI call' : 'cast · 6 steps';
  const pillClass = phase === 'gen' ? 'demo-pill-ai' : '';
  const lines = PLAN_LINES.map((line) => {
    const visible = phase === 'gen' ? '' : ' demo-plan-line-visible';
    const step = 'step' in line ? ` data-plan-step="${line.step}"` : '';
    const marker = 'step' in line ? phase === 'done' ? '✓' : phase === 'run' && line.step === 0 ? '›' : '·' : '';
    const markerClass = phase === 'done' && 'step' in line ? ' demo-plan-marker-ok' : phase === 'run' && 'step' in line && line.step === 0 ? ' demo-plan-marker-active' : '';
    return `<span class="demo-plan-line${visible}"${step}><i class="demo-plan-marker${markerClass}">${marker}</i><span>${escapeHtml(line.text)}</span></span>`;
  }).join('');
  return `<header><span>login.ambercast.plan.json</span><span class="demo-pill ${pillClass}">${label}</span></header><pre>${lines}</pre><footer>+ login.ambercast.grounding.json · 2 files written</footer>`;
}

function browserMarkup(phase: DemoSnapshot['phase'], runFrame = 0): string {
  if (phase === 'done' || runFrame === 5) {
    const label = phase === 'done' ? 'passed · exit 0' : 'replay · 0 AI calls';
    return `<header><span>chromium · headless</span><span class="demo-pill demo-pill-ok">${label}</span></header>${dashboardMarkup()}<footer>${phase === 'done' ? 'report.json → tests/ambercast/.runs/' : 'replaying from cache'}</footer>`;
  }

  const active = phase === 'run';
  const path = runFrame >= 1 ? '/login' : '';
  const email = runFrame >= 3 ? 'mika@example.com' : '';
  const password = runFrame >= 4 ? '••••••••••' : '';
  const pressed = runFrame === 4 ? ' demo-sign-in-pressed' : '';
  const label = active ? 'replay · 0 AI calls' : phase === 'cast' ? 'ready' : 'idle';
  const pillClass = active ? 'demo-pill-ok' : '';
  const dimClass = active ? ' demo-run-browser' : ' demo-browser-dim';

  return `<header><span>chromium · headless</span><span class="demo-pill ${pillClass}">${label}</span></header><div class="demo-browser${dimClass}">${browserUrlMarkup(path)}<div class="demo-browser-app"><h3>Sign in</h3><span class="demo-field">Email<span class="demo-input" data-demo-email>${email}</span></span><span class="demo-field">Password<span class="demo-input" data-demo-password>${password}</span></span><span class="demo-sign-in${pressed}">Sign in</span></div></div><footer>${active ? 'replaying from cache' : phase === 'cast' ? 'plan ready' : 'waiting for a plan'}</footer>`;
}

function browserUrlMarkup(path: string): string {
  return `<div class="demo-browser-url"><span class="demo-browser-dots"><i></i><i></i><i></i></span><span>localhost:3000${path}</span></div>`;
}

function dashboardMarkup(): string {
  return `<div class="demo-browser">${browserUrlMarkup('/dashboard')}<div class="demo-browser-app demo-dashboard"><h3><span class="demo-check">Welcome, Mika</span></h3><i></i><i></i><i></i></div></div>`;
}

function scheduleGenerationFrames(panel: HTMLElement, isCurrent: () => boolean): void {
  const lines = panel.querySelectorAll<HTMLElement>('.demo-plan-line');
  let elapsed = 0;

  for (const [index, delay] of GENERATION_FRAME_DELAYS.entries()) {
    elapsed += delay;
    setTimeout(() => {
      if (isCurrent()) lines[index]?.classList.add('demo-plan-line-visible');
    }, elapsed);
  }
}

function scheduleRunFrames(browserPanel: HTMLElement, planPanel: HTMLElement, isCurrent: () => boolean): void {
  const frames = [
    { delay: 200, frame: 1 },
    { delay: 600, frame: 2 },
    { delay: 1_200, frame: 3 },
    { delay: 1_780, frame: 4 },
    { delay: 1_900, frame: 5 },
  ];

  for (const { delay, frame } of frames) {
    setTimeout(() => {
      if (!isCurrent()) return;

      browserPanel.innerHTML = browserMarkup('run', frame);
      if (frame === 2) {
        scheduleInputTyping(browserPanel, '[data-demo-email]', 'mika@example.com', EMAIL_TYPING_DELAY_MS, isCurrent);
      }
      if (frame === 3) {
        scheduleInputTyping(browserPanel, '[data-demo-password]', '••••••••••', PASSWORD_TYPING_DELAY_MS, isCurrent);
      }
    }, delay);
  }

  const stepFrames = [0, 350, 1_000, 1_580, 2_050, 2_200, 2_350];
  for (const [completedSteps, delay] of stepFrames.entries()) {
    setTimeout(() => {
      if (isCurrent()) updatePlanMarkers(planPanel, completedSteps);
    }, delay);
  }
}

function scheduleInputTyping(
  panel: HTMLElement,
  selector: string,
  value: string,
  characterDelay: number,
  isCurrent: () => boolean,
): void {
  for (let length = 1; length <= value.length; length += 1) {
    setTimeout(() => {
      if (!isCurrent()) return;

      const input = panel.querySelector<HTMLElement>(selector);
      if (input) input.textContent = value.slice(0, length);
    }, length * characterDelay);
  }
}

function updatePlanMarkers(panel: HTMLElement, completedSteps: number): void {
  const stepLines = panel.querySelectorAll<HTMLElement>('[data-plan-step]');
  for (const [index, line] of stepLines.entries()) {
    const marker = line.querySelector<HTMLElement>('.demo-plan-marker');
    if (!marker) continue;
    marker.classList.toggle('demo-plan-marker-ok', index < completedSteps);
    marker.classList.toggle('demo-plan-marker-active', index === completedSteps);
    marker.textContent = index < completedSteps ? '✓' : index === completedSteps ? '›' : '·';
  }
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function statusText(snapshot: DemoSnapshot): string {
  switch (snapshot.phase) {
    case 'gen': return 'NO. 001 · LOGIN · GENERATE · 1 AI CALL';
    case 'cast': return 'NO. 001 · LOGIN · CAST · REVIEW THE DIFF, THEN RUN';
    case 'run': return 'NO. 001 · LOGIN · REPLAY · 0 AI CALLS · CACHE HIT';
    case 'done': return 'NO. 001 · LOGIN · 6/6 STEPS · 2.4S · 0 AI CALLS · EXIT 0';
    default: return 'NO. 001 · LOGIN · IDLE';
  }
}
