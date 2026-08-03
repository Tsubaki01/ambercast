import { describe, expect, it } from 'vitest';
import { createFakeEnvironmentInfo } from '../../doubles/fake-environment-info.js';

describe('createFakeEnvironmentInfo', () => {
  it.each([true, false])('returns the configured CI state %s', (isCI) => {
    expect(createFakeEnvironmentInfo(isCI).isCI()).toBe(isCI);
  });

  it('keeps environment instances isolated', () => {
    const ci = createFakeEnvironmentInfo(true);
    const local = createFakeEnvironmentInfo(false);

    expect(ci.isCI()).toBe(true);
    expect(local.isCI()).toBe(false);
  });
});
