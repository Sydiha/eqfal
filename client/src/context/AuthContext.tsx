import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

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
  handleUnauthorized: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const isVercelPreview = () =>
  typeof window !== 'undefined' &&
  window.location.hostname.endsWith('.vercel.app') &&
  window.location.hostname !== 'eqfal.vercel.app';

const previewSession: AuthSession = {
  user: { id: 'preview-user', email: 'admin@eqfal.test' },
  allowedCompanies: [{ id: 'preview-company', name: 'Al Arz Company', name_ar: 'شركة الأرز' }],
  activeCompanyId: 'preview-company',
  capabilities: [
    'monthly_close.view','fiscal_year.view','document.view','document.upload','document.edit','document.submit','document.review','document.approve',
    'bank.view','bank.import','bank.account.manage','bank.match','bank.reconcile','payment.settle',
    'obligation.view','obligation.create','obligation.edit','obligation.confirm','obligation.settlement.create',
    'accounting.view','vat.view','sales.view','purchase.view','counterparty.create'
  ],
};

const previewJson = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function previewApiResponse(input: RequestInfo | URL): Response | null {
  if (!isVercelPreview()) return null;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const path = new URL(url, window.location.origin).pathname;
  if (path === '/api/auth/session' || path === '/api/auth/login' || path === '/api/auth/switch-company') return previewJson(previewSession);
  if (path === '/api/auth/logout') return previewJson({ ok: true });
  if (path === '/api/manager-financial-snapshot') return previewJson({ metrics: {
    bank_balances: { state: 'available', accounts: [{ id: 'preview-bank', display_name: 'الحساب التشغيلي', currency_code: 'SAR', balance: { state: 'available', amount: '3530000.00' } }] },
    amounts_to_collect: { state: 'available', amount: '5420000.00' },
    amounts_to_pay: { state: 'available', amount: '3160000.00' },
    current_month_sales: { state: 'available', amount: '4280000.00' },
    current_month_purchases_expenses: { state: 'available', amount: '3150000.00' },
  }});
  if (path === '/api/home-alerts') return previewJson({ alerts: [
    { key: 'overdue_obligations', class: 'needs_action_now', ownership: 'current_user', count: 3, destination: 'obligations', parameters: {} },
    { key: 'documents_needs_review', class: 'needs_review_completion', ownership: 'current_user', count: 5, destination: 'documents', parameters: {} },
    { key: 'bank_transactions_unmatched', class: 'needs_review_completion', ownership: 'waiting_for_accountant', count: 8, destination: 'banks', parameters: {} },
    { key: 'upcoming_obligations', class: 'upcoming_due', ownership: 'upcoming', count: 4, destination: 'obligations', parameters: {} },
  ]});
  if (path === '/api/monthly-close-periods') return previewJson({ periods: [{
    id: 'preview-period', fiscal_year_id: 'preview-fy', period_start: '2026-09-01', period_end: '2026-09-30',
    status: 'open', ready: false, disclosed_total: 3, has_hidden_blockers: false,
    blockers: { documents: 1, obligations: 1, bank_transactions: 1, vat: 0, ledger: 0 }
  }]});
  return null;
}

async function parseSession(response: Response): Promise<AuthSession | null> {
  if (!response.ok) return null;
  return response.json() as Promise<AuthSession>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<AuthSession | null>(null);
  const preview = isVercelPreview();
  const handleUnauthorized = useCallback(() => setSession(null), []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        if (preview) {
          if (!cancelled) setSession(previewSession);
          return;
        }
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
  }, [preview]);

  const login = useCallback(async (email: string, password: string): Promise<boolean> => {
    if (preview) { setSession(previewSession); return true; }
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const next = await parseSession(response);
    setSession(next);
    return next !== null;
  }, [preview]);

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
    if (preview) { setSession(previewSession); return companyId === previewSession.activeCompanyId; }
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
  }, [preview]);

  useEffect(() => {
    if (!preview) return;
    const originalFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => previewApiResponse(input) ?? originalFetch(input, init)) as typeof window.fetch;
    return () => { window.fetch = originalFetch; };
  }, [preview]);

  return (
    <AuthContext.Provider value={{ loading, session, login, logout, switchCompany, handleUnauthorized }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an <AuthProvider>');
  return ctx;
}
