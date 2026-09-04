import type { PlanDocument } from '../../../src/core/ir/schema.ts';

/** The schema-validated plan rendered by the landing-page demonstration. */
export const demoPlan = {
  schemaVersion: 2,
  source: {
    inputsDigest: '0000000000000000000000000000000000000000000000000000000000000000',
  },
  steps: [
    {
      action: 'navigate',
      id: 'open-login',
      kind: 'action',
      url: 'https://example.test/login',
    },
    {
      action: 'fill',
      id: 'fill-email',
      kind: 'action',
      target: {
        name: 'Email',
        role: 'textbox',
        strategy: 'accessibility',
      },
      value: 'mika@example.com',
    },
    {
      action: 'fill-secret',
      id: 'fill-password',
      kind: 'action',
      secretGrantSpan: {
        endLine: 3,
        startLine: 3,
      },
      secretRef: '{{secrets.password}}',
      target: {
        name: 'Password',
        role: 'textbox',
        strategy: 'accessibility',
      },
    },
    {
      action: 'click',
      id: 'click-sign-in',
      kind: 'action',
      target: {
        name: 'Sign in',
        role: 'button',
        strategy: 'accessibility',
      },
    },
    {
      check: 'url-matches',
      id: 'assert-dashboard-url',
      kind: 'assert',
      pattern: '/dashboard$',
    },
    {
      check: 'text-visible',
      id: 'assert-welcome-mika',
      kind: 'assert',
      text: 'Welcome, Mika',
    },
  ],
  targets: {
    app: {
      baseUrl: 'https://example.test',
      browser: 'chromium',
    },
  },
} satisfies PlanDocument;
