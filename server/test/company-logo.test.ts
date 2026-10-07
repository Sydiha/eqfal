import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { MAX_LOGO_BYTES, inspectLogo } from '../src/modules/companies/logo-image';

const mocks = vi.hoisted(() => ({ getLogo: vi.fn(), setLogo: vi.fn(), removeLogo: vi.fn() }));
vi.mock('../src/db/pool', () => ({ default: { query: vi.fn(), connect: vi.fn() } as unknown as Pool }));
vi.mock('../src/modules/companies/company.service', async () => {
  const actual = await vi.importActual<typeof import('../src/modules/companies/company.service')>('../src/modules/companies/company.service');
  return { CompanyAccessError: actual.CompanyAccessError, CompanyManagementService: class { getLogo = mocks.getLogo; setLogo = mocks.setLogo; removeLogo = mocks.removeLogo; } };
});
import { companyRouter } from '../src/modules/companies/company.router';
import { CompanyAccessError } from '../src/modules/companies/company.service';
import { SessionRepository } from '../src/modules/auth/session.repository';
import { MembershipRepository } from '../src/modules/memberships/membership.repository';

export const png = (w = 4, h = 4) => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
const jpeg = (w = 8, h = 6) => { const b = Buffer.alloc(24); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0; b.writeUInt16BE(4, 4); b[8] = 0xff; b[9] = 0xc0; b.writeUInt16BE(11, 10); b[12] = 8; b.writeUInt16BE(h, 13); b.writeUInt16BE(w, 15); return b; };
const webp = (w = 10, h = 12) => { const b = Buffer.alloc(32); b.write('RIFF', 0); b.writeUInt32LE(24, 4); b.write('WEBPVP8X', 8); b.writeUInt32LE(10, 16); b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); return b; };

const A = '0e8574b6-5828-40c6-9b56-7dbd1c7e9def';
const B = '1f8574b6-5828-40c6-9b56-7dbd1c7e9def';
const app = express(); app.use(express.json()); app.use('/api', companyRouter);
app.use((e: unknown, _q: Request, res: Response, _n: NextFunction) => res.status(500).json({ error: String(e) }));
const session = { id: 's', user_id: 'user', user_email: 'u@example.com', token_hash: 'h', active_company_id: A, expires_at: new Date(Date.now() + 60_000), created_at: new Date(), updated_at: new Date() };
const cookie = ['Cookie', 'eqfal_session=token'] as const;
const login = (caps: string[]) => {
  vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(session);
  vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue([{ membership_id: 'm', company_id: A, company_name: 'A', company_name_ar: null, role_id: 'r' }]);
  vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities').mockResolvedValue(caps);
};
beforeEach(() => { vi.restoreAllMocks(); Object.values(mocks).forEach((m) => m.mockReset()); mocks.setLogo.mockResolvedValue({ sha256: 'x', size_bytes: 1 }); });

describe('logo image inspection', () => {
  it('accepts PNG, JPEG and WebP and reads dimensions', () => {
    expect(inspectLogo(png(30, 20))).toEqual({ mime: 'image/png', width: 30, height: 20 });
    expect(inspectLogo(jpeg(8, 6))).toEqual({ mime: 'image/jpeg', width: 8, height: 6 });
    expect(inspectLogo(webp(10, 12))).toEqual({ mime: 'image/webp', width: 10, height: 12 });
  });
  it('rejects SVG, text, empty and pathological dimensions', () => {
    expect(inspectLogo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'))).toBeNull();
    expect(inspectLogo(Buffer.from('GIF89a......................................'))).toBeNull();
    expect(inspectLogo(Buffer.alloc(0))).toBeNull();
    expect(inspectLogo(png(5000, 10))).toBeNull();
    expect(inspectLogo(png(0, 10))).toBeNull();
  });
});

describe('company logo routes', () => {
  it('requires authentication', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(null);
    expect((await request(app).get(`/api/companies/${A}/logo`)).status).toBe(401);
    expect((await request(app).put(`/api/companies/${A}/logo`).set('Content-Type', 'image/png').send(png())).status).toBe(401);
    expect((await request(app).delete(`/api/companies/${A}/logo`)).status).toBe(401);
  });
  it('uploads and replaces a valid logo (PNG, JPEG, WebP) using the session user', async () => {
    login([]);
    for (const [type, body] of [['image/png', png()], ['image/jpeg', jpeg()], ['image/webp', webp()]] as const) {
      const res = await request(app).put(`/api/companies/${A}/logo`).set(...cookie).set('Content-Type', type).send(body);
      expect(res.status).toBe(200);
      expect(mocks.setLogo).toHaveBeenLastCalledWith(A, type, body, 'user');
    }
    expect(mocks.setLogo).toHaveBeenCalledTimes(3);
  });
  it('rejects invalid types: SVG, mismatched content type, junk bytes, empty body', async () => {
    login([]);
    const put = (type: string, body: Buffer | string) => request(app).put(`/api/companies/${A}/logo`).set(...cookie).set('Content-Type', type).send(body);
    expect((await put('image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>')).status).toBe(400);
    expect((await put('image/png', jpeg())).status).toBe(400);
    expect((await put('image/png', Buffer.from('not an image at all, just text bytes..........'))).status).toBe(400);
    expect((await put('application/octet-stream', png())).status).toBe(400);
    expect((await put('image/png', png(9000, 9000))).status).toBe(400);
    expect(mocks.setLogo).not.toHaveBeenCalled();
  });
  it('rejects oversized files', async () => {
    login([]);
    const big = Buffer.concat([png(), Buffer.alloc(MAX_LOGO_BYTES + 10)]);
    const res = await request(app).put(`/api/companies/${A}/logo`).set(...cookie).set('Content-Type', 'image/png').send(big);
    expect(res.status).toBe(413);
    expect(mocks.setLogo).not.toHaveBeenCalled();
  });
  it('blocks unauthorized update and remove (service forbids / hides other companies)', async () => {
    login([]);
    mocks.setLogo.mockRejectedValueOnce(new CompanyAccessError('forbidden'));
    expect((await request(app).put(`/api/companies/${A}/logo`).set(...cookie).set('Content-Type', 'image/png').send(png())).status).toBe(403);
    mocks.removeLogo.mockRejectedValueOnce(new CompanyAccessError('not_found'));
    expect((await request(app).delete(`/api/companies/${B}/logo`).set(...cookie)).status).toBe(404);
  });
  it('removes a logo', async () => {
    login([]);
    mocks.removeLogo.mockResolvedValue(undefined);
    expect((await request(app).delete(`/api/companies/${A}/logo`).set(...cookie)).status).toBe(204);
    expect(mocks.removeLogo).toHaveBeenCalledWith(A, 'user');
  });
  it('serves the active company logo with safe headers and ETag; 304 on match', async () => {
    login([]);
    mocks.getLogo.mockResolvedValue({ mime_type: 'image/png', sha256: 'a'.repeat(64), size_bytes: 33, data: png() });
    const res = await request(app).get(`/api/companies/${A}/logo`).set(...cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['etag']).toBe(`"${'a'.repeat(64)}"`);
    expect((await request(app).get(`/api/companies/${A}/logo`).set(...cookie).set('If-None-Match', `"${'a'.repeat(64)}"`)).status).toBe(304);
  });
  it('returns 404 when no logo exists and never reads another company logo', async () => {
    login([]);
    mocks.getLogo.mockResolvedValue(null);
    expect((await request(app).get(`/api/companies/${A}/logo`).set(...cookie)).status).toBe(404);
    mocks.getLogo.mockClear();
    expect((await request(app).get(`/api/companies/${B}/logo`).set(...cookie)).status).toBe(404);
    expect((await request(app).get('/api/companies/not-a-uuid/logo').set(...cookie)).status).toBe(404);
    expect(mocks.getLogo).not.toHaveBeenCalled();
  });
});
