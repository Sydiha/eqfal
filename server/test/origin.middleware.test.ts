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

  it('allows a request with no Origin and no browser evidence when no session cookie is attached', () => {
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

describe('requests without an Origin header (CSRF fallback evidence)', () => {
  const SESSION = 'eqfal_session=tok';
  const hostile = { host: 'localhost:3001', referer: 'https://attacker.example/page' };

  it('rejects a cookie-bearing write with no origin evidence at all', () => {
    const result = invoke({ host: 'localhost:3001', cookie: SESSION });
    expect(result.next).not.toHaveBeenCalled();
    expect(result.status).toHaveBeenCalledWith(403);
    expect(result.json).toHaveBeenCalledWith({ error: 'Request origin could not be verified', code: 'ORIGIN_REQUIRED' });
  });

  it('rejects the session cookie even when other cookies are present', () => {
    const result = invoke({ host: 'localhost:3001', cookie: `a=b; ${SESSION}` });
    expect(result.status).toHaveBeenCalledWith(403);
  });

  it('allows a cookie-free request (no ambient credentials to abuse)', () => {
    expectAllowed({ host: 'localhost:3001', cookie: 'theme=dark' });
  });

  it.each(['cross-site', 'same-site', 'bogus'])('rejects Sec-Fetch-Site: %s without Origin', (site) => {
    expectRejected({ host: 'localhost:3001', cookie: SESSION, 'sec-fetch-site': site });
  });

  it.each(['same-origin', 'none', 'SAME-ORIGIN'])('allows Sec-Fetch-Site: %s without Origin', (site) => {
    expectAllowed({ host: 'localhost:3001', cookie: SESSION, 'sec-fetch-site': site });
  });

  it('rejects a hostile Referer without Origin, with or without the cookie', () => {
    expectRejected(hostile);
    expectRejected({ ...hostile, cookie: SESSION });
  });

  it('rejects malformed, opaque and look-alike Referers', () => {
    for (const referer of ['not a url', 'null', 'http://localhost:3001.attacker.example/x', 'http://attacker.example/http://localhost:3001/', 'javascript:alert(1)']) {
      expectRejected({ host: 'localhost:3001', cookie: SESSION, referer });
    }
  });

  it('allows a Referer from a trusted origin when Origin is absent', () => {
    expectAllowed({ host: 'localhost:3001', cookie: SESSION, referer: 'http://localhost:3001/app/page?x=1' });
  });

  it('Sec-Fetch-Site cross-site wins over a trusted-looking Referer', () => {
    expectRejected({ host: 'localhost:3001', cookie: SESSION, 'sec-fetch-site': 'cross-site', referer: 'http://localhost:3001/' });
  });

  it('treats an empty Origin value as present and invalid', () => {
    expectRejected({ host: 'localhost:3001', cookie: SESSION, origin: '' });
  });

  it('still requires the exact Origin when one is sent, regardless of Referer or Sec-Fetch-Site', () => {
    expectRejected({ host: 'localhost:3001', origin: 'http://attacker.example', referer: 'http://localhost:3001/', 'sec-fetch-site': 'same-origin' });
  });

  describe('production allowlist', () => {
    const prodHeaders = (extra: Request['headers']): Request['headers'] => ({ host: 'internal:3001', cookie: SESSION, ...extra });
    function prod(headers: Request['headers']) {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('APP_PUBLIC_ORIGINS', 'https://app.example.com');
      return invoke(headers, 'https');
    }

    it('accepts only allowlisted Referers and rejects the Host-derived origin', () => {
      expect(prod(prodHeaders({ referer: 'https://app.example.com/dashboard' })).next).toHaveBeenCalledOnce();
      const viaHost = prod(prodHeaders({ referer: 'https://internal:3001/' }));
      expect(viaHost.status).toHaveBeenCalledWith(403);
    });

    it('a forged Host header cannot make a hostile Referer or Origin trusted', () => {
      const forged = prodHeaders({ host: 'attacker.example', referer: 'https://attacker.example/', 'x-forwarded-host': 'attacker.example' });
      expect(prod(forged).status).toHaveBeenCalledWith(403);
      const forgedOrigin = prodHeaders({ host: 'attacker.example', origin: 'https://attacker.example' });
      expect(prod(forgedOrigin).status).toHaveBeenCalledWith(403);
    });

    it('rejects a cookie-bearing write without evidence and a cross-site fetch', () => {
      expect(prod(prodHeaders({})).status).toHaveBeenCalledWith(403);
      expect(prod(prodHeaders({ 'sec-fetch-site': 'cross-site' })).status).toHaveBeenCalledWith(403);
    });

    it('allows same-origin browser evidence for the allowlisted deployment', () => {
      expect(prod(prodHeaders({ 'sec-fetch-site': 'same-origin' })).next).toHaveBeenCalledOnce();
      expect(prod(prodHeaders({ origin: 'https://app.example.com' })).next).toHaveBeenCalledOnce();
    });
  });
});

describe('login and logout keep working for legitimate callers', () => {
  const login = (headers: Record<string, string>) =>
    request(app).post('/api/auth/login').set('Host', 'localhost').set(headers).send({ email: 'a@b.co', password: 'x' });

  it('does not block a same-origin browser login/logout (reaches the handler, never 403 from the guard)', async () => {
    for (const path of ['/api/auth/login', '/api/auth/logout']) {
      const res = await request(app).post(path).set('Host', 'localhost').set('Origin', 'http://localhost').set('Sec-Fetch-Site', 'same-origin').send({ email: 'a@b.co', password: 'x' });
      expect(res.body.code).not.toBe('INVALID_REQUEST_ORIGIN');
      expect(res.body.code).not.toBe('ORIGIN_REQUIRED');
    }
  });

  it('rejects cross-site login and logout (login CSRF / forced logout)', async () => {
    expect((await login({ Origin: 'http://attacker.example' })).body.code).toBe('INVALID_REQUEST_ORIGIN');
    expect((await login({ 'Sec-Fetch-Site': 'cross-site' })).body.code).toBe('INVALID_REQUEST_ORIGIN');
    const logout = await request(app).post('/api/auth/logout').set('Host', 'localhost').set('Cookie', 'eqfal_session=tok').send({});
    expect(logout.status).toBe(403);
    expect(logout.body.code).toBe('ORIGIN_REQUIRED');
  });

  it('lets a cookie-less API client (no session) reach the handler', async () => {
    const res = await login({});
    expect(res.body.code).not.toBe('ORIGIN_REQUIRED');
    expect(res.body.code).not.toBe('INVALID_REQUEST_ORIGIN');
  });

  it('a supported API client that keeps the session cookie sends an allowlisted Origin and passes', async () => {
    vi.stubEnv('APP_PUBLIC_ORIGINS', 'https://api-client.example');
    const res = await request(app).post('/api/auth/logout').set('Host', 'internal').set('Cookie', 'eqfal_session=tok').set('Origin', 'https://api-client.example').send({});
    expect(res.body.code).not.toBe('ORIGIN_REQUIRED');
    expect(res.body.code).not.toBe('INVALID_REQUEST_ORIGIN');
  });
});
