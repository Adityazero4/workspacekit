import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, developmentCookieToken, isLoopbackHost } from './lib/auth';

/**
 * Development sign-in: hands the page the per-process session token as an HttpOnly cookie. It does
 * nothing in production, when `AGENT_WORKSPACE_TOKEN` is set, or when the `Host` is not this machine,
 * where `isSignedIn` must be backed by real authentication.
 *
 * @example
 * export { proxy } from './proxy';
 */
export function proxy(request: NextRequest): NextResponse {
  const response = NextResponse.next();
  const token = isLoopbackHost(request.headers.get('host')) ? developmentCookieToken() : undefined;
  if (token) response.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'strict', path: '/' });
  return response;
}

/**
 * Runs the proxy for the page only, never for the file API.
 *
 * @example
 * export { config } from './proxy';
 */
export const config = { matcher: '/' };
