/**
 * Shared HTTP helpers for the API endpoints.
 */

/**
 * Build a JSON response with caching disabled.
 * @param {unknown} obj Serialized with JSON.stringify as the response body.
 * @param {number} [status=200] HTTP status code.
 * @param {Record<string, string>} [extraHeaders] Merged over the default headers.
 * @returns {Response}
 */
export function json(obj, status = 200, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders },
  });
}

/**
 * Serialize a Set-Cookie header value for the session cookie. `Secure` is only
 * added over HTTPS — browsers (notably Safari) drop Secure cookies on plain
 * http://localhost, which would silently leave local dev with no session.
 */
export function sessionCookie(value, maxAgeSec, secure = true) {
  const parts = [`aa_session=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** A Set-Cookie value that clears the session cookie. */
export function clearSessionCookie(secure = true) {
  return `aa_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

/** Whether this request arrived over HTTPS (so cookies should be Secure). */
export function isHttps(request) {
  return new URL(request.url).protocol === 'https:';
}

/** Parse a Cookie header into a plain object. */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}
