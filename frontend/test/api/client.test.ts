import { describe, expect, it, vi } from 'vitest';
import { AxiosError } from 'axios';
import { api, apiErrorMessage, setTokens, storage } from '../../src/api/client';

describe('expired session', () => {
  it('clears cached identity without reloading the login page on a 401', async () => {
    window.history.replaceState({}, '', '/login');
    setTokens('expired-access', null);
    storage.set('tf_user', JSON.stringify({ id: 1 }));
    await expect(api.get('/api/company-settings', {
      adapter: async (config) => {
        throw new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, undefined, {
          status: 401, statusText: 'Unauthorized', data: {}, headers: {}, config,
        });
      },
    })).rejects.toThrow('Unauthorized');
    expect(storage.get('tf_access')).toBeNull();
    expect(storage.get('tf_refresh')).toBeNull();
    expect(storage.get('tf_user')).toBeNull();
    expect(window.location.pathname).toBe('/login');
  });
});

describe('apiErrorMessage', () => {
  it('explains an unreachable server instead of exposing Network Error', () => {
    vi.stubGlobal('navigator', { onLine: true });
    expect(apiErrorMessage({ isAxiosError: true, message: 'Network Error' }))
      .toBe('Server-এর সাথে সংযোগ হচ্ছে না। কিছুক্ষণ পর আবার চেষ্টা করুন।');
    vi.unstubAllGlobals();
  });

  it('identifies an offline browser', () => {
    vi.stubGlobal('navigator', { onLine: false });
    expect(apiErrorMessage({ isAxiosError: true, message: 'Network Error' }))
      .toBe('Internet connection নেই। সংযোগ ঠিক করে আবার চেষ্টা করুন।');
    vi.unstubAllGlobals();
  });
});
