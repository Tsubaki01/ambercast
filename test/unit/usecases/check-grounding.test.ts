import { describe, expect, it, vi } from 'vitest';
import { computePlanDigest } from '#core/ir/digest.js';
import {
  GroundingDocument,
  PlanDocument,
  type GroundingDocument as GroundingDocumentType,
} from '#core/ir/schema.js';
import type { StorageAdapter } from '#ports/storage.js';
import { inspectGroundingArtifact } from '#usecases/check-grounding.js';
import { createInMemoryStorage } from '../../doubles/create-in-memory-storage.js';

const GROUNDING_PATH = '/workspace/tests/login.ambercast.grounding.json';

const plan = PlanDocument.parse({
  schemaVersion: 2,
  source: { inputsDigest: '0'.repeat(64) },
  targets: { web: { baseUrl: 'https://example.test', browser: 'chromium' } },
  steps: [],
});

function validGrounding(
  overrides: Partial<GroundingDocumentType> = {},
): GroundingDocumentType {
  return GroundingDocument.parse({
    schemaVersion: 1,
    planDigest: computePlanDigest(plan),
    entries: {},
    ...overrides,
  });
}

async function inspectStoredText(text: string) {
  const storage = createInMemoryStorage();
  await storage.writeText(GROUNDING_PATH, text);

  return inspectGroundingArtifact(storage, GROUNDING_PATH, plan);
}

describe('inspectGroundingArtifact', () => {
  it('classifies an absent grounding companion as missing without reading it', async () => {
    const storage = createInMemoryStorage();
    const readText = vi.spyOn(storage, 'readText');

    await expect(inspectGroundingArtifact(storage, GROUNDING_PATH, plan)).resolves.toEqual({ kind: 'missing' });
    expect(readText).not.toHaveBeenCalled();
  });

  it('classifies malformed JSON as invalid', async () => {
    await expect(inspectStoredText('{not json')).resolves.toEqual({ kind: 'invalid' });
  });

  it('classifies a wrong grounding schema version as invalid', async () => {
    await expect(inspectStoredText(JSON.stringify({ ...validGrounding(), schemaVersion: 2 }))).resolves.toEqual({ kind: 'invalid' });
  });

  it('classifies a grounding document missing a required field as invalid', async () => {
    const { entries: _entries, ...missingEntries } = validGrounding();

    await expect(inspectStoredText(JSON.stringify(missingEntries))).resolves.toEqual({ kind: 'invalid' });
  });

  it('classifies JSON null as invalid', async () => {
    await expect(inspectStoredText('null')).resolves.toEqual({ kind: 'invalid' });
  });

  it('classifies a JSON array as invalid', async () => {
    await expect(inspectStoredText('[]')).resolves.toEqual({ kind: 'invalid' });
  });

  it('classifies a bare JSON string as invalid', async () => {
    await expect(inspectStoredText('"grounding"')).resolves.toEqual({ kind: 'invalid' });
  });

  it('classifies a bare JSON number as invalid', async () => {
    await expect(inspectStoredText('183')).resolves.toEqual({ kind: 'invalid' });
  });

  it('classifies a bare JSON boolean as invalid', async () => {
    await expect(inspectStoredText('true')).resolves.toEqual({ kind: 'invalid' });
  });

  it('classifies a document-root unknown property as invalid', async () => {
    await expect(inspectStoredText(JSON.stringify({ ...validGrounding(), unexpected: true }))).resolves.toEqual({ kind: 'invalid' });
  });

  it('classifies an unknown property on an entries value as invalid', async () => {
    await expect(inspectStoredText(JSON.stringify({
      ...validGrounding(),
      entries: {
        'click-submit': {
          kind: 'element',
          fingerprint: { algorithm: 'a11y-neighborhood-v2', hash: 'a'.repeat(64) },
          unexpected: true,
        },
      },
    }))).resolves.toEqual({ kind: 'invalid' });
  });

  it('classifies a schema-valid companion for another plan digest as stale', async () => {
    await expect(inspectStoredText(JSON.stringify(validGrounding({ planDigest: 'b'.repeat(64) })))).resolves.toEqual({ kind: 'stale' });
  });

  it('classifies a matching grounding document with zero entries as valid', async () => {
    await expect(inspectStoredText(JSON.stringify(validGrounding()))).resolves.toEqual({ kind: 'valid' });
  });

  it('classifies a matching grounding document with entries as valid', async () => {
    await expect(inspectStoredText(JSON.stringify(validGrounding({
      entries: {
        'click-submit': {
          kind: 'element',
          fingerprint: { algorithm: 'a11y-neighborhood-v2', hash: 'a'.repeat(64) },
        },
      },
    })))).resolves.toEqual({ kind: 'valid' });
  });

  it('propagates a storage read failure instead of classifying it as invalid', async () => {
    const readFailure = new Error('disk unavailable');
    const storage: Pick<StorageAdapter, 'readText' | 'exists'> = {
      exists: vi.fn(async () => true),
      readText: vi.fn(async () => { throw readFailure; }),
    };

    await expect(inspectGroundingArtifact(storage, GROUNDING_PATH, plan)).rejects.toBe(readFailure);
  });

  it('does not scan a valid, matching entry value that resembles a resolved secret', async () => {
    await expect(inspectStoredText(JSON.stringify(validGrounding({
      entries: {
        'reach-dashboard': {
          kind: 'ai',
          trace: {
            events: [],
            verification: [{
              type: 'assert',
              check: 'text-visible',
              text: '9f3c7a1d6e4b2a8095c1f7e3d8b6a4c20e1f9d7c5b3a8e6f4c2d0b9a7e5c3',
            }],
          },
        },
      },
    })))).resolves.toEqual({ kind: 'valid' });
  });
});
