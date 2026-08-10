import { describe, expect, it, vi } from 'vitest';
import { resolveChromiumAvailability } from '../../contract-browser/support/chromium-availability.js';

describe('resolveChromiumAvailability', () => {
  it('returns true after closing a successfully launched browser', async () => {
    const close = vi.fn(async () => undefined);
    const launch = async () => ({ close });

    await expect(resolveChromiumAvailability(launch, {})).resolves.toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not resolve true before a successful close settles', async () => {
    let resolveClose!: () => void;
    const closeCompletion = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const close = vi.fn(() => closeCompletion);
    const availability = resolveChromiumAvailability(async () => ({ close }), {});
    let settled = false;
    void availability.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    await Promise.resolve();

    expect(close).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    resolveClose();

    await expect(availability).resolves.toBe(true);
  });

  it('returns true after closing a successfully launched browser when CI is true', async () => {
    const close = vi.fn(async () => undefined);
    const launch = async () => ({ close });

    await expect(resolveChromiumAvailability(launch, { CI: 'true' })).resolves.toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it('returns false locally when launch rejects', async () => {
    const rejection = new Error('Chromium is unavailable');
    const launch = async (): Promise<{ close(): Promise<void> }> => {
      throw rejection;
    };

    await expect(resolveChromiumAvailability(launch, {})).resolves.toBe(false);
  });

  it('rethrows the original launch rejection when CI is true', async () => {
    const rejection = new Error('Chromium is unavailable');
    const launch = async (): Promise<{ close(): Promise<void> }> => {
      throw rejection;
    };

    await expect(resolveChromiumAvailability(launch, { CI: 'true' })).rejects.toBe(rejection);
  });

  it('returns false when launch rejects and CI is false', async () => {
    const launch = async (): Promise<{ close(): Promise<void> }> => {
      throw new Error('Chromium is unavailable');
    };

    await expect(resolveChromiumAvailability(launch, { CI: 'false' })).resolves.toBe(false);
  });

  it('returns false when launch rejects and CI is 0', async () => {
    const launch = async (): Promise<{ close(): Promise<void> }> => {
      throw new Error('Chromium is unavailable');
    };

    await expect(resolveChromiumAvailability(launch, { CI: '0' })).resolves.toBe(false);
  });

  it('returns false locally when close rejects', async () => {
    const rejection = new Error('Chromium cleanup failed');
    const launch = async () => ({
      close: async (): Promise<void> => {
        throw rejection;
      },
    });

    await expect(resolveChromiumAvailability(launch, {})).resolves.toBe(false);
  });

  it('rethrows the original close rejection when CI is true', async () => {
    const rejection = new Error('Chromium cleanup failed');
    const launch = async () => ({
      close: async (): Promise<void> => {
        throw rejection;
      },
    });

    await expect(resolveChromiumAvailability(launch, { CI: 'true' })).rejects.toBe(rejection);
  });

  it('returns false when close rejects and CI is false', async () => {
    const launch = async () => ({
      close: async (): Promise<void> => {
        throw new Error('Chromium cleanup failed');
      },
    });

    await expect(resolveChromiumAvailability(launch, { CI: 'false' })).resolves.toBe(false);
  });

  it('returns false when close rejects and CI is 0', async () => {
    const launch = async () => ({
      close: async (): Promise<void> => {
        throw new Error('Chromium cleanup failed');
      },
    });

    await expect(resolveChromiumAvailability(launch, { CI: '0' })).resolves.toBe(false);
  });
});
