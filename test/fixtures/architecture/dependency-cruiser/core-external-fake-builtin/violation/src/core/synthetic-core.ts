// @ts-expect-error -- this fixture deliberately names a builtin-looking unresolved subpath.
import * as fakeCrypto from 'crypto/fake';

/** Synthetic dependency-cruiser fixture; not a product module. */
export const syntheticFakeBuiltin = fakeCrypto;
