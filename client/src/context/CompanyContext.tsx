/**
 * CompanyContext
 *
 * Provides the active company state and a validated setter to the component
 * tree. Designed to be wired to the Auth/Session layer once that is ready;
 * for now, `allowedCompanies` is supplied by the nearest Provider.
 *
 * Guarantees:
 *  · setActiveCompany throws when the requested id is not in allowedCompanies
 *    — it is impossible to select a company the current user cannot access.
 *  · companyKey increments on every successful company switch, giving
 *    downstream components a stable React key to unmount/remount (clearing
 *    all company-scoped local state) without requiring explicit cleanup logic.
 *  · activeCompanyId is always consistent with allowedCompanies: when the
 *    prop changes after mount, the Provider reconciles automatically — it
 *    never leaves a stale id that points to a company no longer permitted.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  type ReactNode,
} from 'react';

// ── Types ────────────────────────────────────────────────────────────────────

export interface Company {
  id: string;
  /** Display name — caller supplies the appropriate localised string. */
  name: string;
}

export interface CompanyContextValue {
  /** ID of the currently active company, or null when none is selected. */
  activeCompanyId: string | null;
  /** Resolved Company object for the active ID, or null. */
  activeCompany: Company | null;
  /** Full list of companies the current user is allowed to access. */
  allowedCompanies: Company[];
  /**
   * Switch to `id`.
   *
   * @throws {Error} when `id` is not present in `allowedCompanies`.
   *   Callers must validate before calling; the error is intentional so that
   *   a coding mistake or a tampered request is immediately visible.
   */
  setActiveCompany: (id: string) => void;
  /**
   * Monotonically increasing counter — increments on every successful
   * company switch. Use as a React `key` on subtrees that must be fully
   * remounted (and therefore have their local state cleared) on switch.
   */
  companyKey: number;
}

// ── Context ──────────────────────────────────────────────────────────────────

const CompanyContext = createContext<CompanyContextValue | null>(null);

// ── Provider ─────────────────────────────────────────────────────────────────

interface CompanyProviderProps {
  /**
   * Companies the authenticated user may access. This list is the sole source
   * of truth: only companies present here can be made active.
   */
  allowedCompanies: Company[];
  /**
   * Optional pre-selected company id (e.g. from session).
   * If absent or not in allowedCompanies, defaults to the first allowed
   * company (or null when the list is empty).
   */
  initialCompanyId?: string | null;
  children: ReactNode;
}

/**
 * Resolve the best available company id from a list.
 * Prefers `preferredId` when it is in the list; falls back to the first
 * element; returns null when the list is empty.
 * Used both for initial state and for post-mount reconciliation.
 */
function resolveSyncedId(
  allowedCompanies: Company[],
  preferredId?: string | null,
): string | null {
  if (preferredId != null && allowedCompanies.some(c => c.id === preferredId)) {
    return preferredId;
  }
  return allowedCompanies[0]?.id ?? null;
}

// ── Reducer ───────────────────────────────────────────────────────────────────

interface CompanyState {
  activeCompanyId: string | null;
  /**
   * Increments only when the active company actually changes.
   * Re-selecting the current company (or a sync that changes nothing)
   * leaves companyKey unchanged.
   */
  companyKey: number;
}

type CompanyAction =
  | { type: 'SET_COMPANY'; id: string }
  | {
      type: 'SYNC_ALLOWED';
      /** Fast-lookup set of currently permitted company ids. */
      allowedIds: ReadonlySet<string>;
      /**
       * Preferred fallback id when the current active id is no longer
       * permitted. Computed from initialCompanyId + new allowedCompanies.
       */
      fallbackId: string | null;
    };

function companyReducer(state: CompanyState, action: CompanyAction): CompanyState {
  switch (action.type) {
    case 'SET_COMPANY':
      // No-op: same company already active — do not churn state or increment key.
      if (state.activeCompanyId === action.id) return state;
      return { activeCompanyId: action.id, companyKey: state.companyKey + 1 };

    case 'SYNC_ALLOWED': {
      const currentId = state.activeCompanyId;
      // Keep the current id only when it is still permitted.
      const newId =
        currentId !== null && action.allowedIds.has(currentId)
          ? currentId
          : action.fallbackId;
      // No effective change — return same object so React skips re-render.
      if (newId === currentId) return state;
      return { activeCompanyId: newId, companyKey: state.companyKey + 1 };
    }
  }
}

// ── Provider ─────────────────────────────────────────────────────────────────

export function CompanyProvider({
  allowedCompanies,
  initialCompanyId,
  children,
}: CompanyProviderProps) {
  const [{ activeCompanyId, companyKey }, dispatch] = useReducer(companyReducer, {
    activeCompanyId: resolveSyncedId(allowedCompanies, initialCompanyId),
    companyKey: 0,
  });

  // ── Post-mount reconciliation ─────────────────────────────────────────────
  // When allowedCompanies changes after the first render (e.g. arriving from
  // Auth/Session), ensure activeCompanyId is still permitted.
  // · Active id still in new list  → no-op (same state object, no re-render).
  // · Active id removed or was null → promote initialCompanyId (if allowed)
  //   or the first available company or null.
  useEffect(() => {
    const allowedIds = new Set(allowedCompanies.map(c => c.id));
    const fallbackId = resolveSyncedId(allowedCompanies, initialCompanyId);
    dispatch({ type: 'SYNC_ALLOWED', allowedIds, fallbackId });
  }, [allowedCompanies, initialCompanyId]);

  const setActiveCompany = useCallback(
    (id: string) => {
      if (!allowedCompanies.some(c => c.id === id)) {
        throw new Error(
          `setActiveCompany: "${id}" is not in the list of allowed companies.`,
        );
      }
      // Dispatch even for the same id — the reducer will return the existing
      // state object unchanged (referential equality), so React skips re-render.
      dispatch({ type: 'SET_COMPANY', id });
    },
    [allowedCompanies],
  );

  const activeCompany =
    allowedCompanies.find(c => c.id === activeCompanyId) ?? null;

  return (
    <CompanyContext.Provider
      value={{
        activeCompanyId,
        activeCompany,
        allowedCompanies,
        setActiveCompany,
        companyKey,
      }}
    >
      {children}
    </CompanyContext.Provider>
  );
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Access company context. Must be rendered inside a `<CompanyProvider>`.
 * @throws when called outside a Provider (programming error).
 */
export function useCompany(): CompanyContextValue {
  const ctx = useContext(CompanyContext);
  if (!ctx) {
    throw new Error('useCompany must be used within a <CompanyProvider>');
  }
  return ctx;
}

/** Active company display name, or null outside a provider (used by report exports). */
export function useActiveCompanyName(): string | null {
  return useContext(CompanyContext)?.activeCompany?.name ?? null;
}

/** Non-throwing variant for optional consumers (e.g. report branding): null outside a CompanyProvider. */
export function useOptionalCompany(): CompanyContextValue | null {
  return useContext(CompanyContext);
}
