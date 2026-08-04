import { describe, expect, it } from 'vitest';
import { readConfigEnvironment } from '../../../../src/adapters/system/process-config-environment.js';

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe('readConfigEnvironment()', () => {
  it('omits both fields when both configuration variables are unset', () => {
    const previousConfig = process.env.AMBERCAST_CONFIG;
    const previousProvider = process.env.AMBERCAST_AI_PROVIDER;

    try {
      delete process.env.AMBERCAST_CONFIG;
      delete process.env.AMBERCAST_AI_PROVIDER;

      const snapshot = readConfigEnvironment();

      expect(snapshot).toStrictEqual({});
    } finally {
      restoreEnvironmentVariable('AMBERCAST_CONFIG', previousConfig);
      restoreEnvironmentVariable('AMBERCAST_AI_PROVIDER', previousProvider);
    }
  });

  it('captures both nonempty configuration variables verbatim', () => {
    const previousConfig = process.env.AMBERCAST_CONFIG;
    const previousProvider = process.env.AMBERCAST_AI_PROVIDER;

    try {
      process.env.AMBERCAST_CONFIG = 'configs/ambercast.local.json';
      process.env.AMBERCAST_AI_PROVIDER = 'codex';

      expect(readConfigEnvironment()).toEqual({
        aiProviderRaw: 'codex',
        configPathOverride: 'configs/ambercast.local.json',
      });
    } finally {
      restoreEnvironmentVariable('AMBERCAST_CONFIG', previousConfig);
      restoreEnvironmentVariable('AMBERCAST_AI_PROVIDER', previousProvider);
    }
  });

  it('captures an unsupported AI provider verbatim without validation', () => {
    const previousConfig = process.env.AMBERCAST_CONFIG;
    const previousProvider = process.env.AMBERCAST_AI_PROVIDER;

    try {
      delete process.env.AMBERCAST_CONFIG;
      process.env.AMBERCAST_AI_PROVIDER = 'not-a-real-provider';

      expect(readConfigEnvironment()).toStrictEqual({ aiProviderRaw: 'not-a-real-provider' });
    } finally {
      restoreEnvironmentVariable('AMBERCAST_CONFIG', previousConfig);
      restoreEnvironmentVariable('AMBERCAST_AI_PROVIDER', previousProvider);
    }
  });

  it('captures whitespace-only configuration variables verbatim', () => {
    const previousConfig = process.env.AMBERCAST_CONFIG;
    const previousProvider = process.env.AMBERCAST_AI_PROVIDER;

    try {
      process.env.AMBERCAST_CONFIG = '   ';
      process.env.AMBERCAST_AI_PROVIDER = '   ';

      expect(readConfigEnvironment()).toStrictEqual({
        aiProviderRaw: '   ',
        configPathOverride: '   ',
      });
    } finally {
      restoreEnvironmentVariable('AMBERCAST_CONFIG', previousConfig);
      restoreEnvironmentVariable('AMBERCAST_AI_PROVIDER', previousProvider);
    }
  });

  it('treats an empty configuration-path variable as absent', () => {
    const previousConfig = process.env.AMBERCAST_CONFIG;
    const previousProvider = process.env.AMBERCAST_AI_PROVIDER;

    try {
      process.env.AMBERCAST_CONFIG = '';
      process.env.AMBERCAST_AI_PROVIDER = 'claude';

      expect(readConfigEnvironment()).toEqual({ aiProviderRaw: 'claude' });
    } finally {
      restoreEnvironmentVariable('AMBERCAST_CONFIG', previousConfig);
      restoreEnvironmentVariable('AMBERCAST_AI_PROVIDER', previousProvider);
    }
  });

  it('treats an empty AI-provider variable as absent', () => {
    const previousConfig = process.env.AMBERCAST_CONFIG;
    const previousProvider = process.env.AMBERCAST_AI_PROVIDER;

    try {
      process.env.AMBERCAST_CONFIG = 'configs/ambercast.local.json';
      process.env.AMBERCAST_AI_PROVIDER = '';

      expect(readConfigEnvironment()).toEqual({ configPathOverride: 'configs/ambercast.local.json' });
    } finally {
      restoreEnvironmentVariable('AMBERCAST_CONFIG', previousConfig);
      restoreEnvironmentVariable('AMBERCAST_AI_PROVIDER', previousProvider);
    }
  });
});
