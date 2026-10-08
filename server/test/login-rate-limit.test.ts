import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

vi.mock('../src/db/pool', () => ({ default: { query: vi.fn(), connect: vi.fn() } as unknown as Pool }));

import { authRouter } from '../src/modules/auth/auth.router';
import { loginRateLimiter, LoginRateLimiter, parseTrustProxy } from '../src/modules/auth/login-rate-limit';
import { SessionService } from '../src/modules/auth/session.service';

function makeApp(trustProxy: boolean | number | string = false) {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.use(express.json());
  app.use('/api', authRouter);
  return app;
}

const bad = (app: express.Express, email: string, ip?: string) => {
  const req = request(app).post('/api/auth/login');
  if (ip) req.set('X-Forwarded-For', ip);
  return req.send({ email, password: 'wrong-password' });
};

describe('H1 login rate limiting', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    loginRateLimiter.reset();
  });

  it('blocks brute force on one account after repeated failures (429 + Retry-After) without reaching bcrypt', async () => {
    const login = vi.spyOn(SessionService.prototype, 'login').mockResolvedValue(null);
    const app = makeApp();
    for (let i = 0; i < 5; i++) expect((await bad(app, 'victim@example.com')).status).toBe(401);
    const blocked = await bad(app, 'victim@example.com');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'Too many login attempts', code: 'LOGIN_RATE_LIMITED' });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(login).toHaveBeenCalledTimes(5);
  });

  it('blocks credential stuffing from one IP across many accounts', async () => {
    const login = vi.spyOn(SessionService.prototype, 'login').mockResolvedValue(null);
    const app = makeApp();
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await bad(app, `user${i}@example.com`)).status;
    expect(last).toBe(429);
    expect(login).toHaveBeenCalledTimes(30);
  });

  it('limits a single account across many IPs (distributed guessing)', async () => {
    vi.spyOn(SessionService.prototype, 'login').mockResolvedValue(null);
    const app = makeApp(1);
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await bad(app, 'victim@example.com', `203.0.113.${i + 1}`)).status;
    expect(last).toBe(429);
  });

  it('a successful login is not blocked after a few typos and resets the pair counter', async () => {
    const login = vi.spyOn(SessionService.prototype, 'login').mockResolvedValue(null);
    const app = makeApp();
    for (let i = 0; i < 4; i++) await bad(app, 'ok@example.com');
    login.mockResolvedValueOnce({ token: 't', user: { id: 'u', email: 'ok@example.com' }, allowedCompanies: [], activeCompanyId: null, capabilities: [] } as never);
    expect((await bad(app, 'ok@example.com')).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await bad(app, 'ok@example.com')).status).toBe(401);
  });

  it('is case-insensitive on email so casing cannot bypass the limit', async () => {
    vi.spyOn(SessionService.prototype, 'login').mockResolvedValue(null);
    const app = makeApp();
    for (let i = 0; i < 5; i++) await bad(app, i % 2 ? 'VICTIM@example.com' : 'victim@example.com');
    expect((await bad(app, 'Victim@Example.com')).status).toBe(429);
  });

  it('ignores a spoofed X-Forwarded-For when no proxy is trusted', async () => {
    vi.spyOn(SessionService.prototype, 'login').mockResolvedValue(null);
    const app = makeApp(false);
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await bad(app, `u${i}@example.com`, `198.51.100.${i + 1}`)).status;
    expect(last).toBe(429);
  });

  it('uses the proxy-supplied client IP when a trusted proxy hop is configured', async () => {
    vi.spyOn(SessionService.prototype, 'login').mockResolvedValue(null);
    const app = makeApp(1);
    for (let i = 0; i < 30; i++) await bad(app, `u${i}@example.com`, '198.51.100.7');
    expect((await bad(app, 'another@example.com', '198.51.100.7')).status).toBe(429);
    expect((await bad(app, 'another@example.com', '198.51.100.8')).status).toBe(401);
  });

  it('does not count malformed requests', async () => {
    const app = makeApp();
    for (let i = 0; i < 40; i++) expect((await request(app).post('/api/auth/login').send({})).status).toBe(400);
  });

  it('expires blocks after the window and bounds memory', () => {
    let now = 1_000;
    const limiter = new LoginRateLimiter({ windowMs: 1000, maxPerIp: 1, maxPerEmailIp: 1, maxPerEmail: 1, maxEntries: 5 }, () => now);
    expect(limiter.reserve('1.1.1.1', 'a@x.com').allowed).toBe(true);
    expect(limiter.reserve('1.1.1.1', 'a@x.com').allowed).toBe(false);
    now += 1001;
    expect(limiter.reserve('1.1.1.1', 'a@x.com').allowed).toBe(true);
    for (let i = 0; i < 50; i++) limiter.reserve(`9.9.9.${i}`, `e${i}@x.com`);
    expect(limiter.size()).toBeLessThanOrEqual(5);
  });

  it('parses TRUST_PROXY safely (default: trust nothing)', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
  });
});
