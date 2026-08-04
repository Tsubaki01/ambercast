import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { getConfigJsonSchema } from '#core/config/json-schema.js';
import { RawConfig } from '#core/config/schema.js';

const CONFIG_SCHEMA_URL = 'https://ambercast.dev/schema/config.json';
const TARGET = { baseUrl: 'https://example.test', browser: 'chromium' } as const;

describe('config JSON Schema document', () => {
  it('returns a strict-compilable JSON Schema 2020-12 document', () => {
    const schema = getConfigJsonSchema();

    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(() => new Ajv2020({ strict: true }).compile(schema)).not.toThrow();
  });

  it('derives an equal but independent schema for every call', () => {
    const first = getConfigJsonSchema();
    const second = getConfigJsonSchema();

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it.each([
    ['a minimal present config file', { $schema: CONFIG_SCHEMA_URL }, true],
    ['a document missing its required $schema', {}, false],
    ['an unknown top-level key', { $schema: CONFIG_SCHEMA_URL, unexpected: true }, false],
    ['a Chromium target', { $schema: CONFIG_SCHEMA_URL, targets: { app: TARGET } }, true],
    ['a bad target entry', { $schema: CONFIG_SCHEMA_URL, targets: { app: { ...TARGET, browser: 'firefox' } } }, false],
    ['a supported AI provider', { $schema: CONFIG_SCHEMA_URL, ai: { provider: 'codex' } }, true],
    ['an invalid AI provider', { $schema: CONFIG_SCHEMA_URL, ai: { provider: 'openai' } }, false],
    ['the lowest valid viewer port', { $schema: CONFIG_SCHEMA_URL, viewer: { port: 1 } }, true],
    ['the highest valid viewer port', { $schema: CONFIG_SCHEMA_URL, viewer: { port: 65_535 } }, true],
    ['a viewer port below the range', { $schema: CONFIG_SCHEMA_URL, viewer: { port: 0 } }, false],
    ['a viewer port above the range', { $schema: CONFIG_SCHEMA_URL, viewer: { port: 65_536 } }, false],
    ['a non-integer viewer port', { $schema: CONFIG_SCHEMA_URL, viewer: { port: 1.5 } }, false],
  ] as const)('matches RawConfig for %s', (_name, document, expected) => {
    const validator = new Ajv2020({ strict: true }).compile(getConfigJsonSchema());
    const zodVerdict = RawConfig.safeParse(document).success;
    const ajvVerdict = validator(document);

    expect.soft(zodVerdict).toBe(expected);
    expect.soft(ajvVerdict).toBe(expected);
    expect(ajvVerdict).toBe(zodVerdict);
  });
});
