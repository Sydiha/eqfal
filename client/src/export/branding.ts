import type { XlsxImage } from './xlsx-builder';

export interface ReportBranding {
  /** data: URL of the validated company logo, or null (no logo / unreadable). Used by the print header. */
  logoDataUrl: string | null;
  /** Company logo normalised to PNG for XLSX (Office cannot be relied on to read WebP). */
  logoPng: XlsxImage | null;
  /** Official EQFAL mark (public/eqfal-mark.svg) rasterised to PNG for XLSX. */
  eqfalPng: XlsxImage | null;
}
export const EQFAL_MARK_URL = '/eqfal-mark.svg';
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp']);
const timeout = <T,>(p: Promise<T>, ms: number, fallback: T) => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function toPng(img: HTMLImageElement, maxHeight: number): XlsxImage | null {
  try {
    const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
    if (!w0 || !h0) return null;
    const k = Math.min(1, maxHeight / h0);
    const width = Math.max(1, Math.round(w0 * k)), height = Math.max(1, Math.round(h0 * k));
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d'); if (!ctx) return null;
    ctx.drawImage(img, 0, 0, width, height);
    const b64 = canvas.toDataURL('image/png').split(',')[1]; if (!b64) return null;
    const bin = atob(b64); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, width, height };
  } catch { return null; }
}

const readDataUrl = (blob: Blob) => new Promise<string | null>((resolve) => {
  const r = new FileReader(); r.onload = () => resolve(typeof r.result === 'string' ? r.result : null); r.onerror = () => resolve(null); r.readAsDataURL(blob);
});

/** Fetches the active company's logo. Any failure (404, network, bad type, undecodable) resolves to null: it must never block a report. */
export async function fetchCompanyLogo(companyId: string): Promise<string | null> {
  try {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`/api/companies/${encodeURIComponent(companyId)}/logo`, { credentials: 'same-origin', signal: controller.signal }).finally(() => clearTimeout(timer));
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!ALLOWED.has(blob.type)) return null;
    const url = await readDataUrl(blob);
    if (!url) return null;
    return (await timeout(loadImage(url), 4000, null)) ? url : null; // drop undecodable data
  } catch { return null; }
}

export async function loadReportBranding(companyId: string): Promise<ReportBranding> {
  const logoDataUrl = await fetchCompanyLogo(companyId);
  const [logoImg, eqfalImg] = await Promise.all([
    logoDataUrl ? timeout(loadImage(logoDataUrl), 4000, null) : Promise.resolve(null),
    timeout(loadImage(EQFAL_MARK_URL), 4000, null),
  ]);
  return { logoDataUrl, logoPng: logoImg ? toPng(logoImg, 112) : null, eqfalPng: eqfalImg ? toPng(eqfalImg, 96) : null };
}
