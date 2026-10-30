import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

export type HomeAlert = {
  key: string;
  class: 'needs_action_now' | 'upcoming_due' | 'needs_review_completion';
  ownership: 'current_user' | 'waiting_for_accountant' | 'waiting_for_team' | 'upcoming';
  count: number;
  destination: 'obligations' | 'documents' | 'banks';
  parameters: Record<string, string>;
};

export type HomeAlertsState = {
  status: 'idle' | 'loading' | 'ready' | 'error' | 'denied';
  alerts: HomeAlert[];
  reload: () => void;
};

// The server only returns alert groups the caller can view; mirror that so no request is made without access.
export const canViewHomeAlerts = (capabilities: readonly string[]) =>
  ['obligation.view', 'document.view', 'bank.view'].some(capability => capabilities.includes(capability));

/** Alerts that need someone to act now; upcoming-due items are informational and never counted. */
export const isActionable = (alert: HomeAlert) => alert.count > 0 && alert.class !== 'upcoming_due';

export const visibleHomeAlerts = (alerts: readonly HomeAlert[]) => {
  const seen = new Set<string>();
  return alerts.filter(alert => {
    if (alert.count <= 0 || seen.has(alert.key)) return false;
    seen.add(alert.key);
    return true;
  });
};

/** Bell count: only the current user's own actionable items. */
export const actionableCount = (alerts: readonly HomeAlert[]) =>
  visibleHomeAlerts(alerts).filter(alert => isActionable(alert) && alert.ownership === 'current_user').reduce((sum, alert) => sum + alert.count, 0);

const HomeAlertsContext = createContext<HomeAlertsState | null>(null);
export const useHomeAlerts = () => useContext(HomeAlertsContext);

export function HomeAlertsProvider({ capabilities, companyId, onUnauthorized, children }: { capabilities: readonly string[]; companyId: string; onUnauthorized: () => void; children: ReactNode }) {
  const allowed = canViewHomeAlerts(capabilities);
  const [state, setState] = useState<Pick<HomeAlertsState, 'status' | 'alerts'>>({ status: allowed ? 'loading' : 'denied', alerts: [] });
  const [tick, setTick] = useState(0);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;
  const reload = useCallback(() => setTick(value => value + 1), []);

  useEffect(() => {
    if (!allowed || !companyId) {
      setState({ status: allowed ? 'idle' : 'denied', alerts: [] });
      return;
    }
    let cancelled = false;
    setState(current => ({ status: 'loading', alerts: current.alerts }));
    void (async () => {
      try {
        const response = await fetch('/api/home-alerts', { credentials: 'same-origin' });
        if (cancelled) return;
        if (response.status === 401) { unauthorized.current(); return; }
        if (response.status === 403) { setState({ status: 'denied', alerts: [] }); return; }
        if (!response.ok) throw new Error(String(response.status));
        const payload = (await response.json()) as { alerts?: HomeAlert[] };
        if (!cancelled) setState({ status: 'ready', alerts: Array.isArray(payload.alerts) ? payload.alerts : [] });
      } catch {
        if (!cancelled) setState({ status: 'error', alerts: [] });
      }
    })();
    return () => { cancelled = true; };
  }, [allowed, companyId, tick]);

  const value = useMemo(() => ({ ...state, reload }), [state, reload]);
  return <HomeAlertsContext.Provider value={value}>{children}</HomeAlertsContext.Provider>;
}
