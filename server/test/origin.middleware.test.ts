import { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/app';
import { requireSameOrigin } from '../src/modules/auth/origin.middleware';

function invoke(headers: Request['headers'], protocol = 'http') {
  const next = vi.fn<NextFunction>();
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));

  requireSameOrigin(
    { headers, protocol } as Request,
    { status } as unknown as Response,
    next,
  );

  return { json, next, status };
}

function expectAllowed(headers: Request['headers'], protocol = 'http') {
  const result = invoke(headers, protocol);
  expect(result.next).toHaveBeenCalledOnce();
  expect(result.status).not.toHaveBeenCalled();
}

function expectRejected(headers: Request['headers'], protocol = 'http') {
  const result = invoke(headers, protocol);
  expect(result.next).not.toHaveBeenCalled();
  expect(result.status).toHaveBeenCalledWith(403);
  expect(result.json).toHaveBeenCalledWith({ error: 'Invalid request origin', code: 'INVALID_REQUEST_ORIGIN' });
}

afterEach(() => vi.unstubAllEnvs());

describe('requireSameOrigin', () => {
  it('allows a direct same-origin request', () => {
    expectAllowed({ host: 'localhost:3001', origin: 'http://localhost:3001' });
  });

  it('rejects a direct cross-origin request', () => {
    expectRejected({ host: 'localhost:3001', origin: 'http://attacker.example' });
  });

  it('rejects malformed origins and origins with credentials', () => {
    expectRejected({ host: 'app.example.com', origin: 'not a URL' }, 'https');
    expectRejected({ host: 'app.example.com', origin: 'https://user:secret@app.example.com' }, 'https');
  });

  it('allows requests without an Origin header', () => {
    expectAllowed({ host: 'app.example.com' }, 'https');
  });

  it('accepts only the exact configured public origin', () => {
    vi.stubEnv('APP_PUBLIC_ORIGINS', ' https://public.example:8443/ ');
    expectAllowed({ host: 'internal:3001', origin: 'https://public.example:8443' });
    expectRejected({ host: 'internal:3001', origin: 'https://other.example:8443' });
    expectRejected({ host: 'internal:3001', origin: 'http://public.example:8443' });
    expectRejected({ host: 'internal:3001', origin: 'https://public.example' });
  });

  it('ignores invalid configured origins without widening access', () => {
    vi.stubEnv('APP_PUBLIC_ORIGINS', 'ftp://public.example, https://public.example/path, https://user@public.example');
    expectRejected({ host: 'internal:3001', origin: 'https://public.example' });
  });

  it('accepts exact Replit runtime domains and rejects wildcard-like matches', () => {
    vi.stubEnv('REPLIT_DEV_DOMAIN', 'dev-app.replit.dev');
    vi.stubEnv('REPLIT_DOMAINS', 'app.replit.app, custom.example');
    expectAllowed({ host: 'localhost:3001', origin: 'https://dev-app.replit.dev' });
    expectAllowed({ host: 'localhost:3001', origin: 'https://app.replit.app' });
    expectAllowed({ host: 'localhost:3001', origin: 'https://custom.example' });
    expectRejected({ host: 'localhost:3001', origin: 'https://unrelated.replit.dev' });
  });

  it('does not trust spoofed forwarded host or protocol headers', () => {
    expectRejected({
      host: 'internal:3001',
      origin: 'https://attacker.example',
      'x-forwarded-host': 'attacker.example',
    });
    expectRejected({
      host: 'app.example',
      origin: 'https://app.example',
      'x-forwarded-proto': 'https',
    });
  });

  it('lets a protected POST reach authentication for the configured Replit origin', async () => {
    vi.stubEnv('REPLIT_DEV_DOMAIN', 'dev-app.replit.dev');
    const response = await request(app)
      .post('/api/obligations')
      .set('Origin', 'https://dev-app.replit.dev')
      .send({});

    // Past the origin check the request must stop at authentication:
    // 503 when no database is configured, 401 (no session) when one is.
    expect(response.status).toBe(process.env['DATABASE_URL'] ? 401 : 503);
    expect(response.body).not.toEqual({ error: 'Invalid request origin' });
  });
});

describe('production origin allowlist is authoritative', () => {
  function prod(headers: Request['headers'], protocol = 'https', extraEnv: Record<string, string> = {}) {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_PUBLIC_ORIGINS', 'https://app.example.com');
    for (const [k, v] of Object.entries(extraEnv)) vi.stubEnv(k, v);
    return invoke(headers, protocol);
  }
  const allowed = (r: ReturnType<typeof invoke>) => expect(r.next).toHaveBeenCalledOnce();
  const rejected = (r: ReturnType<typeof invoke>) => {
    expect(r.next).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(403);
  };

  it('accepts the configured origin', () => {
    allowed(prod({ host: 'internal:3001', origin: 'https://app.example.com' }));
  });
  it('ignores legacy Replit variables', () => {
    const env = { REPLIT_DOMAINS: 'x.replit.app', REPLIT_DEV_DOMAIN: 'y.replit.dev' };
    rejected(prod({ host: 'internal:3001', origin: 'https://x.replit.app' }, 'https', env));
    rejected(prod({ host: 'internal:3001', origin: 'https://y.replit.dev' }, 'https', env));
  });
  it('rejects a forged Host that matches the attacker origin', () => {
    rejected(prod({ host: 'attacker.example', origin: 'https://attacker.example' }));
    rejected(prod({ host: 'attacker.example', origin: 'http://attacker.example' }, 'http'));
  });
  it('rejects the server own host origin when it is not in the allowlist', () => {
    rejected(prod({ host: 'internal:3001', origin: 'https://internal:3001' }));
  });
  it('rejects forwarded headers pointing at an attacker', () => {
    rejected(prod({
      host: 'internal:3001',
      origin: 'https://attacker.example',
      'x-forwarded-host': 'attacker.example',
      'x-forwarded-proto': 'https',
      forwarded: 'host=attacker.example;proto=https',
    }));
  });
  it('rejects everything when the allowlist is empty', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_PUBLIC_ORIGINS', '');
    rejected(invoke({ host: 'app.example.com', origin: 'https://app.example.com' }, 'https'));
  });
});
