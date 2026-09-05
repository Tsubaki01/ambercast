import type { DemoPhase } from './demo-state-machine.ts';
import { demoPlan, demoPrompt } from '../data/demo-plan.ts';
import { classifyPromptLine, escapeHtml, highlightJsonLine } from './landing-format.ts';

/**
 * These plain-string builders are shared by the SSR fallback and client adapter, making a done
 * panel byte-identical whichever rendering path reaches it. Their only interpolated text passes
 * through the formatter escaping boundary before entering the controlled panel HTML sinks.
 */

/** A displayed plan line, with `step` present only for lines that carry a replay marker. */
export interface PlanLine {
  text: string;
  step?: number;
}

/**
 * The adapter derives one generation delay from each entry in this display order. A structural
 * line and a step line must stay in lockstep so progressive generation never reveals the wrong
 * plan row.
 */
export const PLAN_LINES: readonly PlanLine[] = [
  { text: '{' },
  { text: `  "schemaVersion": ${demoPlan.schemaVersion},` },
  { text: `  "source": ${JSON.stringify(demoPlan.source)},` },
  { text: '  "steps": [' },
  ...demoPlan.steps.map((step, index) => ({ text: `    ${JSON.stringify(step)}${index === demoPlan.steps.length - 1 ? '' : ','}`, step: index })),
  { text: '  ],' },
  { text: `  "targets": ${JSON.stringify(demoPlan.targets)}` },
  { text: '}' },
];

/** Returns the complete prompt panel while preserving the source prompt as its `pre` text. */
export function promptMarkup(): string {
  return `<header><span>login.test.md</span><span class="demo-pill">prompt</span></header><pre>${demoPrompt.split('\n').map((line) => `<span class="demo-prompt-line demo-prompt-${classifyPromptLine(line)}">${escapeHtml(line)}</span>`).join('\n')}</pre><footer>plain markdown · committed to git</footer>`;
}

/** Returns the phase-specific plan panel with stable marker and escaping contracts. */
export function planMarkup(phase: DemoPhase): string {
  if (phase === 'idle') return '<header><span>login.ambercast.plan.json</span><span class="demo-pill">empty</span></header><div class="demo-plan-empty">plan appears here<br>after generate</div><footer>+ login.ambercast.grounding.json</footer>';
  const label = phase === 'gen' ? 'casting · 1 AI call' : `cast · ${demoPlan.steps.length} steps`;
  const lines = PLAN_LINES.map((line) => {
    const step = line.step === undefined ? '' : ` data-plan-step="${line.step}"`;
    const marker = line.step === undefined ? '' : phase === 'done' ? '✓' : phase === 'run' && line.step === 0 ? '›' : '·';
    const markerClass = phase === 'done' && line.step !== undefined ? ' demo-plan-marker-ok' : phase === 'run' && line.step === 0 ? ' demo-plan-marker-active' : '';
    return `<span class="demo-plan-line${phase === 'gen' ? '' : ' demo-plan-line-visible'}"${step}><i class="demo-plan-marker${markerClass}">${marker}</i><span>${highlightJsonLine(line.text)}</span></span>`;
  }).join('');
  return `<header><span>login.ambercast.plan.json</span><span class="demo-pill${phase === 'gen' ? ' demo-pill-ai' : ''}">${label}</span></header><pre>${lines}</pre><footer>+ login.ambercast.grounding.json · 2 files written</footer>`;
}

/** Returns the browser specimen for a phase and replay frame. */
export function browserMarkup(phase: DemoPhase, runFrame = 0): string {
  if (phase === 'done' || runFrame === 5) return `<header><span>chromium · headless</span><span class="demo-pill demo-pill-ok">${phase === 'done' ? 'passed · exit 0' : 'replay · 0 AI calls'}</span></header>${dashboardMarkup()}<footer>${phase === 'done' ? 'report.json → tests/ambercast/.runs/' : 'replaying from cache'}</footer>`;
  const active = phase === 'run'; const path = runFrame >= 1 ? '/login' : ''; const email = runFrame >= 3 ? 'mika@example.com' : ''; const password = runFrame >= 4 ? '••••••••••' : '';
  return `<header><span>chromium · headless</span><span class="demo-pill${active ? ' demo-pill-ok' : ''}">${active ? 'replay · 0 AI calls' : phase === 'cast' ? 'ready' : 'idle'}</span></header><div class="demo-browser${active ? ' demo-run-browser' : ' demo-browser-dim'}">${browserUrlMarkup(path)}<div class="demo-browser-app"><h3>Sign in</h3><span class="demo-field">Email<span class="demo-input" data-demo-email>${email}</span></span><span class="demo-field">Password<span class="demo-input" data-demo-password>${password}</span></span><span class="demo-sign-in${runFrame === 4 ? ' demo-sign-in-pressed' : ''}">Sign in</span></div></div><footer>${active ? 'replaying from cache' : phase === 'cast' ? 'plan ready' : 'waiting for a plan'}</footer>`;
}

/**
 * Returns the shared URL strip used by replay and dashboard panels. `path` is untrusted display
 * text and is escaped exactly once before interpolation; only this safe markup may enter the
 * designated set:html and innerHTML panel sinks, where markup-looking paths must remain text.
 */
export function browserUrlMarkup(path: string): string {
  return `<div class="demo-browser-url"><span class="demo-browser-dots"><i></i><i></i><i></i></span><span>localhost:3000${escapeHtml(path)}</span></div>`;
}

/** Returns the completed browser body used by the shared done panel. */
export function dashboardMarkup(): string {
  return `<div class="demo-browser">${browserUrlMarkup('/dashboard')}<div class="demo-browser-app demo-dashboard"><h3><span class="demo-check">Welcome, Mika</span></h3><i></i><i></i><i></i></div></div>`;
}
