import { describe, expectTypeOf, it } from 'vitest';
import type { StorageAdapter } from '../../../src/ports/storage.js';

describe('storage port shape', () => {
  it('defines the complete text, binary, existence, listing, and directory surface', () => {
    expectTypeOf<StorageAdapter['readText']>().toEqualTypeOf<(path: string) => Promise<string>>();
    expectTypeOf<StorageAdapter['writeText']>().toEqualTypeOf<(path: string, content: string) => Promise<void>>();
    expectTypeOf<StorageAdapter['readBinary']>().toEqualTypeOf<(path: string) => Promise<Uint8Array>>();
    expectTypeOf<StorageAdapter['writeBinary']>().toEqualTypeOf<(path: string, content: Uint8Array) => Promise<void>>();
    expectTypeOf<StorageAdapter['exists']>().toEqualTypeOf<(path: string) => Promise<boolean>>();
    expectTypeOf<StorageAdapter['listFiles']>().toEqualTypeOf<(dir: string) => Promise<readonly string[]>>();
    expectTypeOf<StorageAdapter['ensureDir']>().toEqualTypeOf<(dir: string) => Promise<void>>();
  });
});
