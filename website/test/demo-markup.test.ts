import { describe, expect, it } from 'vitest';
import { demoPlan, demoPrompt } from '../src/data/demo-plan.ts';
import { PLAN_LINES, browserMarkup, planMarkup, promptMarkup } from '../src/scripts/demo-markup.ts';
import { GENERATION_FRAME_DELAYS } from '../src/scripts/demo-adapter.ts';

function decodeEntities(text: string): string {
  return text.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

describe('demo markup builders', () => {
  it('renders every prompt line as an escaped classified span without changing its text', () => {
    const markup = promptMarkup();
    expect(markup.match(/demo-prompt-line/g)).toHaveLength(demoPrompt.split('\n').length);
    const prompt = markup.match(/<pre>([\s\S]*)<\/pre>/)?.[1];
    expect(prompt).toBeDefined();
    expect(decodeEntities(prompt?.replace(/<[^>]+>/g, '') ?? '')).toBe(demoPrompt);
    expect(markup).toContain('<header><span>login.test.md</span>');
    expect(markup).toContain('<footer>plain markdown · committed to git</footer>');
  });

  it('keeps the idle plan as a placeholder', () => {
    expect(planMarkup('idle')).toContain('demo-plan-empty');
  });

  it('keeps every generation line individually hidden until cast reveals it', () => {
    const generation = planMarkup('gen');
    const cast = planMarkup('cast');
    expect(generation.match(/class="demo-plan-line"/g)).toHaveLength(PLAN_LINES.length);
    expect(generation).not.toContain('demo-plan-line-visible');
    expect(cast.match(/class="demo-plan-line demo-plan-line-visible"/g)).toHaveLength(PLAN_LINES.length);
  });

  it('maps every plan-step marker to its own step in every replay phase', () => {
    for (const phase of ['cast', 'run', 'done'] as const) {
      const markup = planMarkup(phase);
      expect(markup.match(/data-plan-step="\d+"/g)).toHaveLength(demoPlan.steps.length);
      for (const step of demoPlan.steps.keys()) {
        const line = markup.match(new RegExp(`<span class="demo-plan-line[^>]* data-plan-step="${step}">([\\s\\S]*?)</span></span>`))?.[1];
        expect(line, `${phase} must contain step ${step}`).toBeDefined();
        expect(line).toContain(phase === 'done' ? 'demo-plan-marker-ok">✓' : phase === 'run' && step === 0 ? 'demo-plan-marker-active">›' : 'demo-plan-marker">·');
      }
    }
  });

  it('keeps the plan step count and adapter frame delays aligned', () => {
    expect(PLAN_LINES.filter((line) => line.step !== undefined)).toHaveLength(demoPlan.steps.length);
    expect(PLAN_LINES.length).toBeGreaterThan(demoPlan.steps.length);
    expect(GENERATION_FRAME_DELAYS).toHaveLength(PLAN_LINES.length);
    expect(GENERATION_FRAME_DELAYS).toEqual(PLAN_LINES.map((line) => (line.step === undefined ? 90 : 230)));
    expect(GENERATION_FRAME_DELAYS.reduce((total, delay) => total + delay, 0)).toBe(2010);
  });

  it.each([
    ['idle', 0, '', '', '', false, 'idle', 'waiting for a plan'],
    ['gen', 0, '', '', '', false, 'idle', 'waiting for a plan'],
    ['cast', 0, '', '', '', false, 'ready', 'plan ready'],
    ['run', 0, '', '', '', false, 'replay · 0 AI calls', 'replaying from cache'],
    ['run', 1, '/login', '', '', false, 'replay · 0 AI calls', 'replaying from cache'],
    ['run', 3, '/login', 'mika@example.com', '', false, 'replay · 0 AI calls', 'replaying from cache'],
    ['run', 4, '/login', 'mika@example.com', '••••••••••', true, 'replay · 0 AI calls', 'replaying from cache'],
    ['run', 5, '/dashboard', null, null, false, 'replay · 0 AI calls', 'replaying from cache'],
    ['done', 0, '/dashboard', null, null, false, 'passed · exit 0', 'report.json → tests/ambercast/.runs/'],
  ] as const)('renders %s frame %i with its complete browser contract', (phase, frame, path, email, password, pressed, pill, footer) => {
    const markup = browserMarkup(phase, frame);
    expect(markup).toContain(`localhost:3000${path}`);
    expect(markup).toContain(pill);
    expect(markup).toContain(footer);
    if (email === null) expect(markup).toContain('Welcome, Mika');
    else {
      expect(markup).toContain(`data-demo-email>${email}</span>`);
      expect(markup).toContain(`data-demo-password>${password}</span>`);
      expect(markup.includes('demo-sign-in-pressed')).toBe(pressed);
    }
  });
});
