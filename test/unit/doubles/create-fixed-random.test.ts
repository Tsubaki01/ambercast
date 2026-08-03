import { describe, expect, it } from 'vitest';
import { createFixedRandom } from '../../doubles/create-fixed-random.js';

describe('createFixedRandom', () => {
  it('returns the configured UUID and fractional value repeatedly', () => {
    const random = createFixedRandom('123e4567-e89b-42d3-a456-426614174000', 0.25);

    expect(random.uuid()).toBe('123e4567-e89b-42d3-a456-426614174000');
    expect(random.uuid()).toBe('123e4567-e89b-42d3-a456-426614174000');
    expect(random.float()).toBe(0.25);
    expect(random.float()).toBe(0.25);
  });

  it('preserves boundary fractional values', () => {
    const zero = createFixedRandom('00000000-0000-4000-8000-000000000000', 0);
    const almostOne = createFixedRandom('ffffffff-ffff-4fff-8fff-ffffffffffff', 0.9999999999999999);

    expect(zero.float()).toBe(0);
    expect(almostOne.float()).toBe(0.9999999999999999);
  });

  it('keeps two fixed random sources isolated', () => {
    const first = createFixedRandom('11111111-1111-4111-8111-111111111111', 0.1);
    const second = createFixedRandom('22222222-2222-4222-8222-222222222222', 0.2);

    expect(first.uuid()).toBe('11111111-1111-4111-8111-111111111111');
    expect(second.uuid()).toBe('22222222-2222-4222-8222-222222222222');
    expect(first.float()).toBe(0.1);
    expect(second.float()).toBe(0.2);
  });
});
