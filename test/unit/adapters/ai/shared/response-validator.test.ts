import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validateAiResponse } from '#adapters/ai/shared/response-validator.js';
import { typedJsonSchema } from '#core/ai/typed-json-schema.js';
import { AiResponseInvalidError } from '#core/errors/ai-response-invalid-error.js';

function schema() {
  return typedJsonSchema(z.object({ ok: z.boolean(), count: z.int().positive() }));
}

describe('validateAiResponse', () => {
  it('parses and returns data satisfying the requested JSON Schema', () => {
    expect(validateAiResponse('{"ok":true,"count":1}', schema())).toEqual({ ok: true, count: 1 });
  });

  it('classifies malformed JSON with one empty-path parse issue and raw text', () => {
    const raw = '{"ok":';

    expect(() => validateAiResponse(raw, schema())).toThrow(AiResponseInvalidError);
    try {
      validateAiResponse(raw, schema());
    } catch (error) {
      expect(error).toMatchObject({ kind: 'ai-response-invalid', details: { raw, issues: [expect.objectContaining({ path: '' })] } });
    }
  });

  it('collects every schema-validation issue and renders a root issue as slash', () => {
    const raw = '{"ok":"no","extra":true}';

    expect(() => validateAiResponse(raw, schema())).toThrow(AiResponseInvalidError);
    try {
      validateAiResponse(raw, schema());
    } catch (error) {
      expect(error).toMatchObject({
        details: {
          raw,
          issues: expect.arrayContaining([
            expect.objectContaining({ path: '/ok' }),
            expect.objectContaining({ path: '/count' }),
          ]),
        },
      });
    }
  });

  it('distinguishes a root schema violation from malformed JSON', () => {
    try {
      validateAiResponse('false', schema());
    } catch (error) {
      expect(error).toMatchObject({ details: { issues: [expect.objectContaining({ path: '/' })] } });
    }
  });

  it('registers standard JSON Schema formats before validating provider data', () => {
    const urlSchema = typedJsonSchema(z.object({ callbackUrl: z.url() }));

    expect(validateAiResponse('{"callbackUrl":"https://example.test/callback"}', urlSchema))
      .toEqual({ callbackUrl: 'https://example.test/callback' });
    expect(() => validateAiResponse('{"callbackUrl":"not a URL"}', urlSchema))
      .toThrow(AiResponseInvalidError);
  });

  it('escapes required property names when rendering JSON Pointer paths', () => {
    const slashKeySchema = typedJsonSchema(z.object({ 'token/key': z.string() }));

    try {
      validateAiResponse('{}', slashKeySchema);
    } catch (error) {
      expect(error).toMatchObject({
        details: { issues: [expect.objectContaining({ path: '/token~1key' })] },
      });
    }
  });
});
