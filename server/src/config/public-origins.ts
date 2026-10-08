import { Request } from 'express';

const warnedEntries = new Set<string>();

function warnInvalid(source: string, value: string): void {
  const key = `${source}:${value}`;
  if (warnedEntries.has(key)) return;
  warnedEntries.add(key);
  console.warn(`Ignoring invalid ${source} public origin configuration`);
}

export function normalizeAbsoluteOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      !url.host ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function configuredOrigins(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').flatMap((entry) => {
    const trimmed = entry.trim();
    const origin = normalizeAbsoluteOrigin(trimmed);
    if (!origin) warnInvalid('APP_PUBLIC_ORIGINS', trimmed);
    return origin ? [origin] : [];
  });
}

function replitOrigins(source: string, value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').flatMap((entry) => {
    const host = entry.trim();
    const origin = normalizeAbsoluteOrigin(`https://${host}`);
    if (!origin || new URL(origin).host !== host) {
      warnInvalid(source, host);
      return [];
    }
    return [origin];
  });
}

function directRequestOrigin(req: Request): string | undefined {
  const host = req.headers.host;
  if (typeof host !== 'string') return undefined;
  return normalizeAbsoluteOrigin(`${req.protocol}://${host}`);
}

/** Resolve the exact public origins accepted for this request. */
export function trustedPublicOrigins(
  req: Request,
  environment: NodeJS.ProcessEnv = process.env,
): Set<string> {
  // Production: the explicit APP_PUBLIC_ORIGINS allowlist is authoritative. The request-derived
  // origin (Host header) and legacy Replit variables are never added, so forged Host or
  // X-Forwarded-* headers cannot widen it.
  if (environment['NODE_ENV'] === 'production') {
    return new Set(configuredOrigins(environment['APP_PUBLIC_ORIGINS']));
  }
  return new Set([
    directRequestOrigin(req),
    ...configuredOrigins(environment['APP_PUBLIC_ORIGINS']),
    ...replitOrigins('REPLIT_DOMAINS', environment['REPLIT_DOMAINS']),
    ...replitOrigins('REPLIT_DEV_DOMAIN', environment['REPLIT_DEV_DOMAIN']),
  ].filter((origin): origin is string => origin !== undefined));
}
