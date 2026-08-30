export type QueryValueOptions = {
  allowedValues?: readonly string[];
  pattern?: RegExp;
};

export type HistoryMode = 'push' | 'replace';

export function readQueryParameter(
  name: string,
  options: QueryValueOptions = {},
  search = window.location.search,
): string | null {
  const value = new URLSearchParams(search).get(name);
  if (!value) return null;
  if (options.allowedValues && !options.allowedValues.includes(value)) return null;
  if (options.pattern && !options.pattern.test(value)) return null;
  return value;
}

export function writeQueryParameters(
  changes: Readonly<Record<string, string | null | undefined>>,
  mode: HistoryMode = 'push',
): void {
  const url = new URL(window.location.href);
  for (const [name, value] of Object.entries(changes)) {
    if (value) url.searchParams.set(name, value);
    else url.searchParams.delete(name);
  }
  window.history[mode === 'replace' ? 'replaceState' : 'pushState'](null, '', url);
}

export function clearQueryParameters(names: readonly string[], mode: HistoryMode = 'push'): void {
  writeQueryParameters(Object.fromEntries(names.map(name => [name, null])), mode);
}

/**
 * Removes company-scoped operational state while retaining the current page.
 * URL state is navigation state only and must never be used as an authorization boundary.
 */
export function clearContextualQueryState(mode: HistoryMode = 'replace'): void {
  const page = new URLSearchParams(window.location.search).get('page');
  const url = new URL(window.location.href);
  url.search = '';
  if (page) url.searchParams.set('page', page);
  window.history[mode === 'replace' ? 'replaceState' : 'pushState'](null, '', url);
}

/** Navigates to a collision-free workspace context while preserving browser Back. */
export function navigateToQueryState(
  parameters: Readonly<Record<string, string | null | undefined>>,
): void {
  const url = new URL(window.location.href);
  url.search = '';
  for (const [name, value] of Object.entries(parameters)) {
    if (value) url.searchParams.set(name, value);
  }
  window.history.pushState(null, '', url);
}
