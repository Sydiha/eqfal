import { describe, expect, it } from 'vitest';
import { generateTemporaryPassword, validateNewPassword } from '../src/modules/users/password-policy';

describe('validateNewPassword', () => {
  const ctx = { email: 'amira.k@example.com', currentPassword: 'OldPassw0rd!' };
  it('accepts a normal password', () => expect(validateNewPassword('A-better-pass-42', ctx)).toBeNull());
  it('rejects short, over-72-byte, unchanged and email-derived passwords', () => {
    expect(validateNewPassword('short', ctx)).toBe('PASSWORD_TOO_SHORT');
    expect(validateNewPassword('x'.repeat(73), ctx)).toBe('PASSWORD_TOO_LONG');
    expect(validateNewPassword('ك'.repeat(37), ctx)).toBe('PASSWORD_TOO_LONG'); // 74 bytes: bcrypt would truncate silently
    expect(validateNewPassword('OldPassw0rd!', ctx)).toBe('PASSWORD_SAME_AS_CURRENT');
    expect(validateNewPassword('AMIRA.K@example.com', ctx)).toBe('PASSWORD_CONTAINS_EMAIL');
    expect(validateNewPassword('amira.k', ctx)).toBe('PASSWORD_TOO_SHORT');
  });
});

describe('generateTemporaryPassword', () => {
  it('is 16 unambiguous characters and different every time', () => {
    const values = new Set(Array.from({ length: 200 }, () => generateTemporaryPassword()));
    expect(values.size).toBe(200);
    for (const value of values) expect(value).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789]{16}$/);
  });
});
