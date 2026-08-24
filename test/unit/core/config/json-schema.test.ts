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
    ['a target with a secret-sink origin', { $schema: CONFIG_SCHEMA_URL, targets: { app: { ...TARGET, secretSinkOrigins: { '{{secrets.app.password}}': ['https://idp.example.test'] } } } }, true],
    ['a bad target entry', { $schema: CONFIG_SCHEMA_URL, targets: { app: { ...TARGET, browser: 'firefox' } } }, false],
    ['a target URL embedding a secret reference', { $schema: CONFIG_SCHEMA_URL, targets: { app: { ...TARGET, baseUrl: 'https://example.com/{{secrets.TOKEN}}' } } }, false],
    ['a target secret-sink origin with a path', { $schema: CONFIG_SCHEMA_URL, targets: { app: { ...TARGET, secretSinkOrigins: { '{{secrets.app.password}}': ['https://idp.example.test/path'] } } } }, false],
    ['a supported AI provider', { $schema: CONFIG_SCHEMA_URL, ai: { provider: 'codex' } }, true],
    ['an invalid AI provider', { $schema: CONFIG_SCHEMA_URL, ai: { provider: 'openai' } }, false],
    ['the positive AI timeout boundary', { $schema: CONFIG_SCHEMA_URL, ai: { timeoutMs: 1 } }, true],
    ['a zero AI timeout', { $schema: CONFIG_SCHEMA_URL, ai: { timeoutMs: 0 } }, false],
    ['a negative AI timeout', { $schema: CONFIG_SCHEMA_URL, ai: { timeoutMs: -1 } }, false],
    ['a fractional AI timeout', { $schema: CONFIG_SCHEMA_URL, ai: { timeoutMs: 1.5 } }, false],
    ['a wrong-typed AI timeout', { $schema: CONFIG_SCHEMA_URL, ai: { timeoutMs: '1000' } }, false],
    ['the lowest valid viewer port', { $schema: CONFIG_SCHEMA_URL, viewer: { port: 1 } }, true],
    ['the highest valid viewer port', { $schema: CONFIG_SCHEMA_URL, viewer: { port: 65_535 } }, true],
    ['a viewer port below the range', { $schema: CONFIG_SCHEMA_URL, viewer: { port: 0 } }, false],
    ['a viewer port above the range', { $schema: CONFIG_SCHEMA_URL, viewer: { port: 65_536 } }, false],
    ['a non-integer viewer port', { $schema: CONFIG_SCHEMA_URL, viewer: { port: 1.5 } }, false],
    ['a committed grounding policy', { $schema: CONFIG_SCHEMA_URL, grounding: { repositoryPolicy: 'committed' } }, true],
    ['an uncommitted grounding policy', { $schema: CONFIG_SCHEMA_URL, grounding: { repositoryPolicy: 'uncommitted' } }, true],
    ['an automatic grounding write-back posture', { $schema: CONFIG_SCHEMA_URL, grounding: { localWriteBack: 'auto' } }, true],
    ['an explicit grounding write-back posture', { $schema: CONFIG_SCHEMA_URL, grounding: { localWriteBack: 'explicit' } }, true],
    ['a complete grounding group', { $schema: CONFIG_SCHEMA_URL, grounding: { repositoryPolicy: 'committed', localWriteBack: 'explicit' } }, true],
    ['an empty grounding group', { $schema: CONFIG_SCHEMA_URL, grounding: {} }, true],
    ['an invalid grounding policy', { $schema: CONFIG_SCHEMA_URL, grounding: { repositoryPolicy: 'local' } }, false],
    ['an invalid grounding write-back posture', { $schema: CONFIG_SCHEMA_URL, grounding: { localWriteBack: 'manual' } }, false],
    ['an unknown grounding key', { $schema: CONFIG_SCHEMA_URL, grounding: { unexpected: true } }, false],
  ] as const)('matches RawConfig for %s', (_name, document, expected) => {
    const validator = new Ajv2020({ strict: true }).compile(getConfigJsonSchema());
    const zodVerdict = RawConfig.safeParse(document).success;
    const ajvVerdict = validator(document);

    expect.soft(zodVerdict).toBe(expected);
    expect.soft(ajvVerdict).toBe(expected);
    expect(ajvVerdict).toBe(zodVerdict);
  });
});
