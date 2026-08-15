import axios, { AxiosError } from 'axios';

const baseURL = import.meta.env.VITE_API_URL || '';
export const api = axios.create({ baseURL, timeout: 30000 });

/** Storage can be unavailable in privacy-mode/embedded browser contexts. */
export const storage = {
  get(key: string): string | null {
    try { return window.localStorage?.getItem(key) ?? null; } catch { return null; }
  },
  set(key: string, value: string): void {
    try { window.localStorage?.setItem(key, value); } catch { /* continue in memory */ }
  },
  remove(key: string): void {
    try { window.localStorage?.removeItem(key); } catch { /* continue in memory */ }
  },
};

/** Resolves a backend-relative path (e.g. an uploaded logo's "/uploads/...") to an absolute URL. */
export function resolveAssetUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return `${baseURL}${path}`;
}

let accessToken: string | null = storage.get('tf_access');

export function setTokens(access: string | null, refresh?: string | null) {
  accessToken = access;
  if (access) storage.set('tf_access', access);
  else storage.remove('tf_access');
  if (refresh !== undefined) {
    if (refresh) storage.set('tf_refresh', refresh);
    else storage.remove('tf_refresh');
  }
}

api.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  return config;
});

// On 401 → try one silent refresh-token rotation, then replay the request.
let refreshing: Promise<string | null> | null = null;
api.interceptors.response.use(undefined, async (error: AxiosError) => {
  const original = error.config as typeof error.config & { _retried?: boolean };
  if (error.response?.status === 401 && original && !original._retried && !original.url?.includes('/auth/')) {
    original._retried = true;
    refreshing ??= (async () => {
      try {
        const refreshToken = storage.get('tf_refresh');
        if (!refreshToken) return null;
        const { data } = await axios.post(`${baseURL}/api/auth/refresh`, { refreshToken });
        setTokens(data.data.accessToken, data.data.refreshToken);
        return data.data.accessToken as string;
      } catch { setTokens(null, null); return null; }
      finally { setTimeout(() => { refreshing = null; }, 0); }
    })();
    const token = await refreshing;
    if (token) { original.headers!.Authorization = `Bearer ${token}`; return api(original); }
    window.location.href = '/login';
  }
  throw error;
});

export function apiErrorMessage(err: unknown): string {
  const e = err as AxiosError<{ message?: string; errors?: { field?: string; path?: string; message: string }[] }>;
  if (e.response?.data?.errors?.length)
    return e.response.data.errors.map((x) => `${x.field ?? x.path ?? 'field'}: ${x.message}`).join(', ');
  return e.response?.data?.message ?? e.message ?? 'Something went wrong';
}

/** Authenticated PDF download — opens the blob in a new tab. */
export async function openPdf(url: string) {
  const res = await api.get(url, { responseType: 'blob' });
  window.open(URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' })), '_blank');
}
