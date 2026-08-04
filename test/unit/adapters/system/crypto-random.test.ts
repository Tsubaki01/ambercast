import { describe, expect, it } from 'vitest';
import { createCryptoRandom } from '../../../../src/adapters/system/crypto-random.js';
import { registerRandomSourceContract } from '../../../contracts/random-source.contract.js';

registerRandomSourceContract({
  createRandom: createCryptoRandom,
});

describe('createCryptoRandom()', () => {
  it('returns an RFC 4122 version 4 UUID', () => {
    const random = createCryptoRandom();

    expect(random.uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('returns different UUIDs from two successive calls', () => {
    const random = createCryptoRandom();

    expect(random.uuid()).not.toBe(random.uuid());
  });

  it('returns numeric fractional values in the half-open unit interval', () => {
    const random = createCryptoRandom();
    const value = random.float();

    expect(value).toEqual(expect.any(Number));
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1);
  });
});
