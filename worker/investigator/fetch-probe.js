// THE UPSTREAM READ.
//
// One function performs every outbound request this Worker can ever make, and it can only be called with a registry
// entry: the URL, host, method, byte cap, timeout, and accepted content types all come from committed policy. It
// sends no credential, no cookie, and no client header, and it follows a redirect only when the destination is the
// same host under the same path prefix.
//
// It returns normalized page TEXT plus retrieval facts. Raw HTML never leaves this module: the text it produces is
// what the (internal) cache stores and what fact extraction reads, and only extracted facts are ever returned to a
// browser.
import { htmlToText, normalizeWhitespace, extractProbeFacts } from '../../src/investigator/research.js';
import { RESEARCH_USER_AGENT } from '../../src/investigator/research.js';
import { assertAllowedRedirect } from './policies.js';

export const FAILURE_CODE = Object.freeze({
  TIMEOUT: 'timeout',
  NETWORK: 'network_error',
  THROTTLED: 'throttled',
  HTTP_ERROR: 'http_error',
  UNEXPECTED_CONTENT_TYPE: 'unexpected_content_type',
  RESPONSE_TOO_LARGE: 'response_too_large',
  REDIRECT_BLOCKED: 'redirect_blocked',
  DECODE_FAILED: 'decode_failed',
  BODY_UNREADABLE: 'body_unreadable',
});

// A transient failure may be retried once; throttling and content problems never are, because retrying them either
// makes the upstream angrier or cannot succeed.
const RETRYABLE = new Set([FAILURE_CODE.TIMEOUT, FAILURE_CODE.NETWORK]);
const JSON_LIKE = /^(application|text)\/(json|[a-z0-9.+-]*\+json)/i;

export function failure(code, message, { httpStatus = null, retryable = RETRYABLE.has(code) } = {}) {
  return Object.freeze({ ok: false, code, message, httpStatus, retryable });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Read a response body with a hard byte ceiling, aborting the stream the moment the ceiling is passed.
async function readBounded(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, bytes: declared, reason: 'declared content-length exceeds the cap' };
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) return { ok: false, bytes: buffer.byteLength, reason: 'body exceeds the cap' };
    return { ok: true, bytes: new Uint8Array(buffer) };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value?.byteLength ?? 0;
    if (total > maxBytes) { try { await reader.cancel(); } catch { /* the stream is already unusable */ } return { ok: false, bytes: total, reason: 'body exceeded the cap while streaming' }; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { ok: true, bytes };
}

function decode(bytes, contentType) {
  const charset = /charset=\s*"?([^;"]+)/i.exec(contentType ?? '')?.[1]?.trim().toLowerCase() ?? 'utf-8';
  const label = ['utf-8', 'utf8', 'ascii', 'us-ascii', 'iso-8859-1', 'latin1', 'windows-1252'].includes(charset) ? charset : 'utf-8';
  try { return new TextDecoder(label, { fatal: false }).decode(bytes); }
  catch { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); }
}

// One upstream read for one probe policy. `fetchImpl` is injected so tests never touch the network.
export async function fetchProbePage({ probe, policy, fetchImpl = fetch, now = () => new Date(), requestId = null }) {
  const startedAt = Date.now();
  const attempts = [];
  let redirects = 0;
  let url = policy.url.href;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response = null;
    try {
      response = await fetchImpl(url, { method: policy.method,
        // The only headers this Worker sends. No client header, cookie, or credential is forwarded anywhere.
        headers: { Accept: 'text/html,application/xhtml+xml,application/json;q=0.9', 'User-Agent': RESEARCH_USER_AGENT, 'Accept-Language': 'en' },
        redirect: 'manual',
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(policy.timeoutMs) : undefined });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      const failureValue = failure(timedOut ? FAILURE_CODE.TIMEOUT : FAILURE_CODE.NETWORK,
        timedOut ? `the source did not answer within ${policy.timeoutMs} ms` : `the source could not be reached (${error?.message ?? 'unknown error'})`);
      attempts.push({ attempt, url, code: failureValue.code, message: failureValue.message });
      if (failureValue.retryable && attempt === 1) { await sleep(250); continue; }
      return Object.freeze({ ok: false, failure: failureValue, attempts: Object.freeze(attempts), durationMs: Date.now() - startedAt, url });
    }

    const status = response.status ?? 0;
    // A redirect is only ever followed to the same host under the same path prefix; anything else is a failure and
    // is reported as one, because following it would make this Worker an open proxy in one hop.
    if (status >= 300 && status < 400) {
      const location = response.headers?.get?.('location') ?? null;
      attempts.push({ attempt, url, code: FAILURE_CODE.REDIRECT_BLOCKED, message: `HTTP ${status} with ${location ? `location ${location}` : 'no readable location'}` });
      if (!location) return Object.freeze({ ok: false, failure: failure(FAILURE_CODE.REDIRECT_BLOCKED, `the source answered HTTP ${status} and the redirect target was not readable, so it was not followed`),
        attempts: Object.freeze(attempts), durationMs: Date.now() - startedAt, url, httpStatus: status });
      if (redirects >= policy.maxRedirects) return Object.freeze({ ok: false, failure: failure(FAILURE_CODE.REDIRECT_BLOCKED, `the source redirected more than ${policy.maxRedirects} time(s)`),
        attempts: Object.freeze(attempts), durationMs: Date.now() - startedAt, url, httpStatus: status });
      let next = null;
      try { next = assertAllowedRedirect(location, url, policy); }
      catch (error) { return Object.freeze({ ok: false, failure: failure(FAILURE_CODE.REDIRECT_BLOCKED, error.message), attempts: Object.freeze(attempts),
        durationMs: Date.now() - startedAt, url, httpStatus: status }); }
      redirects += 1;
      url = next.href;
      continue;
    }

    if (status === 429) return Object.freeze({ ok: false, failure: failure(FAILURE_CODE.THROTTLED, 'the source throttled this request (HTTP 429); Road Naturalist does not retry a throttled source'),
      attempts: Object.freeze([...attempts, { attempt, url, code: FAILURE_CODE.THROTTLED, message: 'HTTP 429' }]), durationMs: Date.now() - startedAt, url, httpStatus: status });
    if (status >= 500) {
      attempts.push({ attempt, url, code: FAILURE_CODE.HTTP_ERROR, message: `HTTP ${status}` });
      if (attempt === 1) { await sleep(250); continue; }
      return Object.freeze({ ok: false, failure: failure(FAILURE_CODE.HTTP_ERROR, `the source answered HTTP ${status}`), attempts: Object.freeze(attempts),
        durationMs: Date.now() - startedAt, url, httpStatus: status });
    }
    if (status < 200 || status >= 300) return Object.freeze({ ok: false, failure: failure(FAILURE_CODE.HTTP_ERROR, `the source answered HTTP ${status}`), attempts: Object.freeze(attempts),
      durationMs: Date.now() - startedAt, url, httpStatus: status });

    const contentType = (response.headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const accepted = policy.contentTypes.some(allowed => contentType === allowed.toLowerCase())
      || (JSON_LIKE.test(contentType) && policy.contentTypes.some(allowed => allowed.toLowerCase().includes('json')));
    if (!accepted) return Object.freeze({ ok: false, failure: failure(FAILURE_CODE.UNEXPECTED_CONTENT_TYPE,
      contentType ? `the source answered with content type ${contentType}, which this probe does not accept` : 'the source answered without a content type, so the body was not read'),
      attempts: Object.freeze([...attempts, { attempt, url, code: FAILURE_CODE.UNEXPECTED_CONTENT_TYPE, message: contentType || 'missing' }]),
      durationMs: Date.now() - startedAt, url, httpStatus: status, contentType: contentType || null });

    const body = await readBounded(response, policy.maxBytes).catch(error => ({ ok: false, bytes: null, reason: error.message }));
    if (!body.ok) return Object.freeze({ ok: false, failure: failure(FAILURE_CODE.RESPONSE_TOO_LARGE, `the source body is larger than the ${policy.maxBytes} byte cap (${body.reason})`),
      attempts: Object.freeze([...attempts, { attempt, url, code: FAILURE_CODE.RESPONSE_TOO_LARGE, message: body.reason }]), durationMs: Date.now() - startedAt, url, httpStatus: status, contentType });

    const decoded = decode(body.bytes, contentType);
    const text = normalizeWhitespace(JSON_LIKE.test(contentType) ? decoded : htmlToText(decoded));
    return Object.freeze({ ok: true, sourceUrl: policy.url.href, finalUrl: url, redirected: redirects > 0, redirects,
      httpStatus: status, contentType, upstreamBytes: body.bytes.byteLength, textBytes: text.length, text,
      fetchedAt: now().toISOString(), attempts: Object.freeze(attempts), durationMs: Date.now() - startedAt, requestId });
  }
  return Object.freeze({ ok: false, failure: failure(FAILURE_CODE.NETWORK, 'the source could not be read'), attempts: Object.freeze(attempts), durationMs: Date.now() - startedAt, url });
}

// Fact extraction is the shared, deterministic rule set — the same function the browser transport uses.
export function extractFacts(probe, text) { return extractProbeFacts(probe, text); }
