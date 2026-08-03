import type { RandomSource } from '../../src/ports/system.js';

export function createFixedRandom(_uuid: string, _float: number): RandomSource {
  return {
    uuid(): string {
      throw new Error('not implemented');
    },
    float(): number {
      throw new Error('not implemented');
    },
  };
}
