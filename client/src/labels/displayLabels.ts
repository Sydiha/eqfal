import type { TFunction } from 'i18next';

const BUILT_IN_ROLES: Readonly<Record<string, string>> = {
  'full access': 'Full Access', 'company manager': 'Company Manager', 'finance manager': 'Finance Manager',
  accountant: 'Accountant', operations: 'Operations', viewer: 'Viewer',
};

/** Localize a built-in role label while preserving custom role names verbatim. */
export function roleDisplayName(name: string | null | undefined, t: TFunction): string {
  if (!name) return '';
  const builtIn = BUILT_IN_ROLES[name.trim().toLowerCase()];
  return builtIn ? t(`home.roleNames.${builtIn}`, { defaultValue: name }) : name;
}
