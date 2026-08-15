import { describe, expect, it, vi } from 'vitest';
import { apiErrorMessage } from '../../src/api/client';

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
