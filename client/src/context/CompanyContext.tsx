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
 */

import {
  createContext,
  useCallback,
  useContext,
  useState,
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

function resolveInitialId(
  allowedCompanies: Company[],
  initialCompanyId?: string | null,
): string | null {
  if (initialCompanyId && allowedCompanies.some(c => c.id === initialCompanyId)) {
    return initialCompanyId;
  }
  return allowedCompanies[0]?.id ?? null;
}

export function CompanyProvider({
  allowedCompanies,
  initialCompanyId,
  children,
}: CompanyProviderProps) {
  const [activeCompanyId, setActiveCompanyId] = useState<string | null>(
    () => resolveInitialId(allowedCompanies, initialCompanyId),
  );
  const [companyKey, setCompanyKey] = useState(0);

  const setActiveCompany = useCallback(
    (id: string) => {
      if (!allowedCompanies.some(c => c.id === id)) {
        throw new Error(
          `setActiveCompany: "${id}" is not in the list of allowed companies.`,
        );
      }
      setActiveCompanyId(id);
      // Increment regardless of whether the id is the same — a deliberate
      // re-selection still signals a "switch intent" and clears stale state.
      setCompanyKey(k => k + 1);
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
