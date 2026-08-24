import { describe, expect, it } from 'vitest';
import {
  groundingWriteBackAllowed,
  type GroundingWriteBackOptions,
} from '#usecases/run.js';

describe('groundingWriteBackAllowed', () => {
  it.each<readonly [string, GroundingWriteBackOptions, boolean]>([
    ['allows an automatic local write without --update-cache', {
      localWriteBack: 'auto', updateCache: false, isCI: false, updateGroundingCacheConfig: false,
    }, true],
    ['allows an automatic local write with --update-cache', {
      localWriteBack: 'auto', updateCache: true, isCI: false, updateGroundingCacheConfig: false,
    }, true],
    ['rejects an explicit local write without --update-cache', {
      localWriteBack: 'explicit', updateCache: false, isCI: false, updateGroundingCacheConfig: false,
    }, false],
    ['allows an explicit local write with --update-cache', {
      localWriteBack: 'explicit', updateCache: true, isCI: false, updateGroundingCacheConfig: false,
    }, true],
    ['rejects a CI automatic write without either CI opt-in', {
      localWriteBack: 'auto', updateCache: false, isCI: true, updateGroundingCacheConfig: false,
    }, false],
    ['allows a CI automatic write with --update-cache', {
      localWriteBack: 'auto', updateCache: true, isCI: true, updateGroundingCacheConfig: false,
    }, true],
    ['allows a CI automatic write with the configured grounding-cache opt-in', {
      localWriteBack: 'auto', updateCache: false, isCI: true, updateGroundingCacheConfig: true,
    }, true],
    ['rejects a CI explicit write without either CI opt-in', {
      localWriteBack: 'explicit', updateCache: false, isCI: true, updateGroundingCacheConfig: false,
    }, false],
    ['does not let the CI cache opt-in affect an explicit local write', {
      localWriteBack: 'explicit', updateCache: false, isCI: false, updateGroundingCacheConfig: true,
    }, false],
    ['allows the configured CI cache opt-in regardless of explicit local posture', {
      localWriteBack: 'explicit', updateCache: false, isCI: true, updateGroundingCacheConfig: true,
    }, true],
  ])('%s', (_description, options, expected) => {
    expect(groundingWriteBackAllowed(options)).toBe(expected);
  });
});
