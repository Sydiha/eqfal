export const MAX_DISPLAY_NAME_LENGTH = 100;

/**
 * Administrator-entered display name (migration 095). Returns the trimmed name, null for "no name" (absent, null or blank),
 * or undefined when the value is invalid. Never derived from the email.
 */
export function parseDisplayName(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return [...trimmed].length <= MAX_DISPLAY_NAME_LENGTH && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : undefined;
}
