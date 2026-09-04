/**
 * Defines English landing-page copy separately from Astro markup so locale-specific data
 * reuses the same layout without forking its interaction contract.
 */
export interface LandingCopy {
  hero: {
    eyebrow: string;
    title: string;
    summary: string;
    primaryCta: string;
    installCommand: string;
  };
  figureOne: {
    sourceNode: string;
    sourceCaption: string;
    generateLabel: string;
    generateCallout: string;
    castNode: string;
    runLabel: string;
    runCallout: string;
    replayNode: string;
    healPill: string;
    caption: string;
  };
  commands: {
    eyebrow: string;
    heading: string;
    rows: ReadonlyArray<{
      number: string;
      command: string;
      description: string;
      status: string;
    }>;
  };
  prerequisites: {
    eyebrow: string;
    heading: string;
    summary: string;
    entries: ReadonlyArray<{
      term: string;
      description: string;
    }>;
  };
  footer: {
    github: string;
    npm: string;
    changelog: string;
    license: string;
    specimen: string;
  };
}

export const enLanding = {
  hero: {
    eyebrow: 'CAST ONCE · REPLAY · 0 AI CALLS',
    title: 'Prompt-native E2E testing.',
    summary: 'Cast once. Keep the intent intact. Write the test as a Markdown prompt, generate a plan once, replay it deterministically: 0 AI calls whenever the cache hits.',
    primaryCta: 'Get started',
    installCommand: 'npm install -D ambercast',
  },
  figureOne: {
    sourceNode: 'login.test.md',
    sourceCaption: 'prompt',
    generateLabel: 'generate',
    generateCallout: '1 AI call',
    castNode: 'cast',
    runLabel: 'run',
    runCallout: '0 AI calls when cached',
    replayNode: 'replay ×N',
    healPill: '↑ ui drift → heal · re-resolves, repairs or regenerates only the affected steps · asks before writing',
    caption: 'FIG. 1 · CAST ONCE, REPLAY DETERMINISTICALLY',
  },
  commands: {
    eyebrow: 'NO. 002 · COMMANDS',
    heading: 'Three commands. One of them calls AI.',
    rows: [
      { number: '01', command: 'ambercast generate', description: 'Reads the prompt, writes plan and grounding as plain JSON. Review them like a lockfile.', status: 'AI · 1 call' },
      { number: '02', command: 'ambercast run', description: 'Replays the plan in a real browser. A cache miss falls back to one AI-assisted step; --cache-only enforces the no-AI path.', status: 'REPLAY · 0 AI CALLS' },
      { number: '03', command: 'ambercast heal', description: 'When the UI drifts, re-resolves, repairs or regenerates only the affected steps, and asks before writing.', status: 'AI · ASKS FIRST' },
    ],
  },
  prerequisites: {
    eyebrow: 'NO. 003 · PREREQUISITES',
    heading: 'Bring your own agent.',
    summary: 'ambercast uses the coding agent you already have, with your own credentials. It manages no keys of its own.',
    entries: [
      { term: 'Runtime', description: 'Node.js ≥ 22.14' },
      { term: 'Browser', description: 'npx playwright-core install chromium. Chromium only, for now.' },
      { term: 'Agent', description: 'claude or codex CLI, installed and authenticated. Default ai.provider: "auto" looks for claude, then codex.' },
    ],
  },
  footer: { github: 'GitHub', npm: 'npm v0.1.0', changelog: 'Changelog', license: 'MIT', specimen: 'PRE-1.0 · CHROMIUM · LOCAL' },
} satisfies LandingCopy;
