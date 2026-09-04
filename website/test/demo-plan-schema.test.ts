import { describe, expect, it } from 'vitest';
import { toCanonicalArtifactText } from '../../src/core/ir/canonical-json.ts';
import type { JsonValueT } from '../../src/core/ir/schema.ts';
import { PlanDocument } from '../../src/core/ir/schema.ts';
import { demoPlan } from '../src/data/demo-plan.ts';
import { PLAN_LINES } from '../src/scripts/demo-adapter.ts';

describe('demoPlan', () => {
  it('parses the six-step login demonstration with the production IR validator', () => {
    const parsed = PlanDocument.parse(demoPlan);

    expect(parsed.steps.map((step) => step.id)).toEqual([
      'open-login',
      'fill-email',
      'fill-password',
      'click-sign-in',
      'assert-dashboard-url',
      'assert-welcome-mika',
    ]);
    expect(parsed.steps).toHaveLength(6);
  });

  it('rejects a fill-secret step whose secret reference is not a whole secret token', () => {
    const broken = structuredClone(demoPlan) as {
      steps: Array<Record<string, unknown>>;
    };
    const passwordStep = broken.steps[2];

    if (!passwordStep) throw new Error('The password step is missing.');

    broken.steps[2] = { ...passwordStep, secretRef: 'password' };

    expect(() => PlanDocument.parse(broken)).toThrow();
  });

  it('renders every key in a multi-field step in the production canonical order', () => {
    const rendered = PLAN_LINES.find((line) => 'step' in line && line.step === 1);

    if (!rendered || !('step' in rendered)) throw new Error('The email-fill display line is missing.');

    const canonical = JSON.stringify(
      JSON.parse(toCanonicalArtifactText(demoPlan.steps[1] as JsonValueT)),
    );
    const displayed = rendered.text.trim().replace(/,$/, '');

    expect(displayed).toBe(canonical);
  });
});
