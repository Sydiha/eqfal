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

    expect(response.status).toBe(503);
    expect(response.body).not.toEqual({ error: 'Invalid request origin' });
  });
});
