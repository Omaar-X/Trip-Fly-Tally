import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { api, setTokens, storage } from '../api/client';

export interface User { id: number; name: string; email: string; role: string; companyId: number; }

interface AuthCtx {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>(null as never);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    const raw = storage.get('tf_user');
    if (!raw) return null;
    try { return JSON.parse(raw) as User; }
    catch {
      storage.remove('tf_user');
      return null;
    }
  });
  const [loading, setLoading] = useState(true);

  // re-validate session on mount (also picks up role changes)
  useEffect(() => {
    (async () => {
      try {
        if (storage.get('tf_access')) {
          const { data } = await api.get('/api/auth/me');
          setUser(data.data);
          storage.set('tf_user', JSON.stringify(data.data));
        }
      } catch { /* interceptor handles refresh / redirect */ }
      finally { setLoading(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function login(email: string, password: string) {
    const { data } = await api.post('/api/auth/login', { email, password });
    setTokens(data.data.accessToken, data.data.refreshToken);
    setUser(data.data.user);
    storage.set('tf_user', JSON.stringify(data.data.user));
  }

  async function logout() {
    const refreshToken = storage.get('tf_refresh');
    try { if (refreshToken) await api.post('/api/auth/logout', { refreshToken }); } catch { /* ignore */ }
    setTokens(null, null);
    storage.remove('tf_user');
    setUser(null);
  }

  return <Ctx.Provider value={{ user, loading, login, logout }}>{children}</Ctx.Provider>;
}
