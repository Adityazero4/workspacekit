import { randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Name of the cookie that carries the sign-in token.
 *
 * @example
 * response.cookies.set(SESSION_COOKIE, token, { httpOnly: true });
 */
export const SESSION_COOKIE = 'agent-workspace-session';

const processWide = globalThis as typeof globalThis & { agentWorkspaceToken?: string };

function configuredToken(): string | undefined {
  const token = process.env.AGENT_WORKSPACE_TOKEN?.trim();
  return token ? token : undefined;
}

/**
 * The token that counts as signed in: `AGENT_WORKSPACE_TOKEN` when it is set and not blank, else one random
 * value per server process, shared by every route bundle.
 *
 * @example
 * const token = sessionToken();
 */
export function sessionToken(): string {
  return configuredToken() ?? (processWide.agentWorkspaceToken ??= randomUUID());
}

/**
 * The token to hand the page as a cookie: the per-process random token in development only. Nothing in
 * production, and nothing when `AGENT_WORKSPACE_TOKEN` is set, because that is a secret a browser must
 * never be given.
 *
 * @example
 * const token = developmentCookieToken();
 * if (token) response.cookies.set(SESSION_COOKIE, token, { httpOnly: true });
 */
export function developmentCookieToken(): string | undefined {
  if (process.env.NODE_ENV !== 'development' || configuredToken()) return undefined;
  return sessionToken();
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * True when a `Host` header names this machine (`localhost`, `127.0.0.1` or `[::1]`, any port). The
 * development cookie is handed only to such requests, so a page reached over the LAN or through a rebound
 * DNS name never receives it.
 *
 * @example
 * const local = isLoopbackHost(request.headers.get('host'));
 */
export function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : (host.split(':')[0] ?? '');
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

function decoded(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function cookieValue(request: Request, name: string): string | undefined {
  for (const pair of (request.headers.get('cookie') ?? '').split(';')) {
    const separatorAt = pair.indexOf('=');
    if (separatorAt !== -1 && pair.slice(0, separatorAt).trim() === name) {
      return decoded(pair.slice(separatorAt + 1).trim());
    }
  }
  return undefined;
}

/**
 * True when the request carries the session token. This is the one place to swap in real authentication
 * (a session library, a JWT check, your identity provider); it is never open by default.
 *
 * @example
 * const authorize = async (req: Request) => isSignedIn(req);
 */
export function isSignedIn(request: Request): boolean {
  const cookie = cookieValue(request, SESSION_COOKIE);
  if (!cookie) return false;
  const presented = Buffer.from(cookie);
  const expected = Buffer.from(sessionToken());
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
