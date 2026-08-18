import { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { requireSameOrigin } from '../src/modules/auth/origin.middleware';

function invoke(headers: Request['headers']) {
  const next = vi.fn<NextFunction>();
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));

  requireSameOrigin(
    { headers } as Request,
    { status } as unknown as Response,
    next,
  );

  return { json, next, status };
}

describe('requireSameOrigin', () => {
  it('allows an origin matching the host header', () => {
    const result = invoke({ host: 'app.example.com', origin: 'https://app.example.com' });

    expect(result.next).toHaveBeenCalledOnce();
    expect(result.status).not.toHaveBeenCalled();
  });

  it('allows an origin matching the forwarded host header', () => {
    const result = invoke({
      host: 'internal.example.com',
      origin: 'https://preview.example.com',
      'x-forwarded-host': 'preview.example.com',
    });

    expect(result.next).toHaveBeenCalledOnce();
    expect(result.status).not.toHaveBeenCalled();
  });

  it('inspects comma-separated forwarded hosts and skips invalid tokens', () => {
    const result = invoke({
      host: 'internal.example.com',
      origin: 'https://preview.example.com:8443',
      'x-forwarded-host': 'invalid host, preview.example.com:8443',
    });

    expect(result.next).toHaveBeenCalledOnce();
    expect(result.status).not.toHaveBeenCalled();
  });

  it('allows an origin matching host when the forwarded host differs', () => {
    const result = invoke({
      host: 'preview.example.com',
      origin: 'https://preview.example.com',
      'x-forwarded-host': 'internal.example.com',
    });

    expect(result.next).toHaveBeenCalledOnce();
    expect(result.status).not.toHaveBeenCalled();
  });

  it('rejects an unrelated origin', () => {
    const result = invoke({
      host: 'app.example.com',
      origin: 'https://attacker.example.com',
      'x-forwarded-host': 'proxy.example.com',
    });

    expect(result.next).not.toHaveBeenCalled();
    expect(result.status).toHaveBeenCalledWith(403);
    expect(result.json).toHaveBeenCalledWith({ error: 'Invalid request origin' });
  });

  it('rejects a malformed origin', () => {
    const result = invoke({ host: 'app.example.com', origin: 'not a URL' });

    expect(result.next).not.toHaveBeenCalled();
    expect(result.status).toHaveBeenCalledWith(403);
    expect(result.json).toHaveBeenCalledWith({ error: 'Invalid request origin' });
  });

  it('allows requests without an origin', () => {
    const result = invoke({ host: 'app.example.com' });

    expect(result.next).toHaveBeenCalledOnce();
    expect(result.status).not.toHaveBeenCalled();
  });
});
