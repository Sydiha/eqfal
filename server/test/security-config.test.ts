import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import app from '../src/app';
import { validateProductionConfig } from '../src/config/production-config';
import { sessionCookieOptions } from '../src/modules/auth/auth.router';
import { securityHeaders } from '../src/shared/security-headers';

const good = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://u:p@db/x',
  APP_PUBLIC_ORIGINS: 'https://app.example.com',
  TRUST_PROXY: '1',
};

describe('validateProductionConfig', () => {
  it('accepts a complete production config without any Replit variable', () => {
    expect(validateProductionConfig(good)).toEqual([]);
  });
  it('does nothing outside production', () => {
    expect(validateProductionConfig({ NODE_ENV: 'development' })).toEqual([]);
  });
  it('requires DATABASE_URL and APP_PUBLIC_ORIGINS', () => {
    expect(validateProductionConfig({ NODE_ENV: 'production' })).toHaveLength(2);
  });
  it('rejects non-https and malformed public origins', () => {
    expect(validateProductionConfig({ ...good, APP_PUBLIC_ORIGINS: 'http://app.example.com' })).toHaveLength(1);
    expect(validateProductionConfig({ ...good, APP_PUBLIC_ORIGINS: 'nonsense' })).toHaveLength(1);
  });
  it.each(['true', 'TRUE', '*', '0.0.0.0/0', '::/0', '10.0.0.1, 0.0.0.0/0'])('rejects trust-all TRUST_PROXY=%s', (v) => {
    expect(validateProductionConfig({ ...good, TRUST_PROXY: v })).toHaveLength(1);
  });
  it.each([undefined, '', 'false', '1', '2', '10.0.0.0/8'])('allows safe TRUST_PROXY=%s', (v) => {
    expect(validateProductionConfig({ ...good, TRUST_PROXY: v })).toEqual([]);
  });
  it('never echoes secret values in messages', () => {
    const msg = validateProductionConfig({ NODE_ENV: 'production', DATABASE_URL: '', APP_PUBLIC_ORIGINS: 'http://secret-host', TRUST_PROXY: 'true' }).join(' ');
    expect(msg).not.toContain('secret-host');
  });
});

describe('session cookie options', () => {
  it('is Secure, HttpOnly, SameSite=Lax in production', () => {
    expect(sessionCookieOptions('production')).toEqual({ httpOnly: true, sameSite: 'lax', secure: true, path: '/' });
  });
  it('is not Secure outside production so local http works', () => {
    expect(sessionCookieOptions('development').secure).toBe(false);
    expect(sessionCookieOptions('development').httpOnly).toBe(true);
  });
});

describe('HTTP hardening', () => {
  it('sends security headers and no X-Powered-By on API responses', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
  it('adds HSTS only in production', async () => {
    const prod = express();
    prod.use(securityHeaders(true));
    prod.get('/x', (_q, r) => void r.send('ok'));
    const res = await request(prod).get('/x');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
  });
  it('returns generic errors for malformed JSON without leaking parser details or stack', async () => {
    const res = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"email":');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request body' });
    expect(res.text).not.toMatch(/SyntaxError|at .*\.(js|ts)|node_modules/);
  });
  it('returns 413 with a fixed message for oversized bodies', async () => {
    const res = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send(JSON.stringify({ a: 'x'.repeat(70000) }));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'Payload too large' });
  });
});
