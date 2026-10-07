import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { parseApiError, toApiError } from '../api/apiError';

export interface AuthCompany {
  id: string;
  name: string;
  name_ar: string | null;
}

export interface AuthUser {
  id: string;
  email: string;
}

export interface AuthSession {
  user: AuthUser;
  allowedCompanies: AuthCompany[];
  activeCompanyId: string | null;
  capabilities: string[];
}

interface AuthContextValue {
  loading: boolean;
  session: AuthSession | null;
  login: (email: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  switchCompany: (companyId: string) => Promise<boolean>;
  refreshSession: () => Promise<void>;
  handleUnauthorized: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function parseSession(response: Response): Promise<AuthSession | null> {
  if (!response.ok) return null;
  return response.json() as Promise<AuthSession>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<AuthSession | null>(null);
  const handleUnauthorized = useCallback(() => setSession(null), []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch('/api/auth/session', { credentials: 'same-origin' });
        const next = await parseSession(response);
        if (!cancelled) setSession(next);
      } catch {
        if (!cancelled) setSession(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<boolean> => {
    let response: Response;
    try {
      response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
    } catch (reason) {
      throw toApiError(reason);
    }
    // 401 means the credentials were rejected; any other failure (400/403/503/5xx) is surfaced
    // as an ApiError so the form never tells the user their password is wrong for a service issue.
    if (!response.ok && response.status !== 401) throw await parseApiError(response);
    const next = await parseSession(response);
    setSession(next);
    return next !== null;
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      });
    } finally {
      setSession(null);
    }
  }, []);

  const switchCompany = useCallback(async (companyId: string): Promise<boolean> => {
    const response = await fetch('/api/auth/switch-company', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ companyId }),
    });

    if (response.status === 401) {
      setSession(null);
      return false;
    }

    const next = await parseSession(response);
    if (!next) return false;
    setSession(next);
    return true;
  }, []);


  const refreshSession = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch('/api/auth/session', { credentials: 'same-origin' });
      if (response.status === 401) { setSession(null); return; }
      const next = await parseSession(response);
      if (next) setSession(next);
    } catch {
      // keep the current session; the next request surfaces any real failure
    }
  }, []);

  return (
    <AuthContext.Provider value={{ loading, session, login, logout, switchCompany, refreshSession, handleUnauthorized }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an <AuthProvider>');
  return ctx;
}
