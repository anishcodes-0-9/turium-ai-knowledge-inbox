import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchUrl, validateUrl, type FetchOptions } from '../src/services/urlFetcher.js';
import { AppError } from '../src/errors.js';

/** Local server impersonating "public.test"; the test IP policy allows only 127.0.0.1. */
let server: http.Server;
let port: number;
/** Paths whose server-side connection has closed; proves the client cancelled the request. */
const closedPaths: string[] = [];
const hosts: Record<string, string> = { 'public.test': '127.0.0.1', 'internal.test': '10.0.0.5', 'meta.test': '169.254.169.254', 'v6.test': '::1' };

const opts = (over: Partial<FetchOptions> = {}): FetchOptions => ({
  timeoutMs: 2000,
  maxBytes: 5000,
  maxRedirects: 2,
  resolve: async (h) => {
    if (!hosts[h]) throw new Error('ENOTFOUND');
    return [hosts[h]!];
  },
  ipPolicy: (ip) => ip === '127.0.0.1',
  ...over,
});
const u = (path: string, host = 'public.test') => `http://${host}:${port}${path}`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = req.url ?? '/';
    if (path === '/page') return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<html><title>Hi</title><body><p>hello world</p></body></html>');
    if (path === '/plain') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('just text');
    if (path === '/pdf') return void res.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF');
    if (path === '/big') return void res.writeHead(200, { 'content-type': 'text/html', 'content-length': '999999' }).end('x'.repeat(999999));
    if (path === '/big-stream') {
      res.writeHead(200, { 'content-type': 'text/html' });
      let n = 0;
      const push = () => { if (n++ < 40 && res.write('y'.repeat(1000))) setImmediate(push); else if (n >= 40) res.end(); else res.once('drain', push); };
      return push();
    }
    const drip = (status: number, headers: http.OutgoingHttpHeaders) => {
      // Headers immediately, then one byte every 50ms forever: an idle timeout never fires.
      res.writeHead(status, headers);
      const iv = setInterval(() => res.write('x'), 50);
      res.on('close', () => {
        clearInterval(iv);
        closedPaths.push(path);
      });
    };
    if (path === '/drip') return drip(200, { 'content-type': 'text/html' });
    if (path === '/drip-redirect') return drip(302, { location: '/page', 'content-type': 'text/html' });
    if (path === '/drip-500') return drip(500, { 'content-type': 'text/html' });
    if (path === '/slow-hop') return void setTimeout(() => res.writeHead(302, { location: '/slow-hop' }).end(), 150);
    if (path === '/slow') return void setTimeout(() => res.writeHead(200, { 'content-type': 'text/html' }).end('late'), 1500);
    if (path === '/redirect-ok') return void res.writeHead(302, { location: '/page' }).end();
    if (path === '/redirect-internal') return void res.writeHead(302, { location: `http://internal.test:${port}/page` }).end();
    if (path === '/redirect-file') return void res.writeHead(302, { location: 'file:///etc/passwd' }).end();
    if (path === '/redirect-loop') return void res.writeHead(302, { location: '/redirect-loop' }).end();
    if (path === '/redirect-noloc') return void res.writeHead(302).end();
    if (path === '/500') return void res.writeHead(500).end('boom');
    if (path === '/404') return void res.writeHead(404).end('nope');
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<p>${req.headers.host}</p>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const expectCode = async (p: Promise<unknown>, code: string, status?: number) => {
  const err = await p.then(() => null).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  if (status) expect((err as AppError).status).toBe(status);
  return err as AppError;
};

describe('validateUrl', () => {
  it('accepts normal http/https URLs', () => {
    expect(validateUrl('https://example.com/a?b=1').href).toBe('https://example.com/a?b=1');
    expect(validateUrl('  http://example.com  ').href).toBe('http://example.com/');
  });
  it.each(['ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'gopher://x', 'data:text/html,hi'])('rejects scheme %s', (url) =>
    expect(() => validateUrl(url)).toThrow(/scheme|not valid/),
  );
  it('rejects malformed URLs and embedded credentials', () => {
    expect(() => validateUrl('not a url')).toThrow(/not valid/);
    expect(() => validateUrl('http://user:pw@example.com')).toThrow(/credentials/);
    expect(() => validateUrl('http://user@example.com')).toThrow(/credentials/);
  });
  it.each(['http://localhost/', 'http://LOCALHOST:8080/', 'http://foo.localhost/', 'http://db.internal/', 'http://printer.local/', 'http://x.home.arpa/'])(
    'blocks local hostname %s',
    (url) => expect(() => validateUrl(url)).toThrow(AppError),
  );
  it.each(['http://127.0.0.1/', 'http://10.1.2.3/', 'http://192.168.0.1/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/', 'http://0.0.0.0/'])(
    'blocks literal private IP %s',
    (url) => {
      const err = (() => { try { validateUrl(url); return null; } catch (e) { return e as AppError; } })();
      expect(err?.code).toBe('url_blocked');
      expect(err?.status).toBe(422);
    },
  );
  it('allows public literal IPs', () => {
    expect(validateUrl('http://8.8.8.8/').hostname).toBe('8.8.8.8');
  });
});

describe('fetchUrl', () => {
  it('fetches an HTML page and reports content type', async () => {
    const doc = await fetchUrl(u('/page'), opts());
    expect(doc.contentType).toBe('text/html');
    expect(doc.body).toContain('hello world');
    expect(doc.redirects).toBe(0);
    expect(doc.finalUrl).toBe(u('/page'));
  });
  it('sends the original Host header while connecting to the pinned IP', async () => {
    const doc = await fetchUrl(u('/host'), opts());
    expect(doc.body).toContain(`public.test:${port}`);
  });
  it('accepts text/plain', async () => {
    expect((await fetchUrl(u('/plain'), opts())).body).toBe('just text');
  });
  it('rejects unsupported content types', async () => {
    await expectCode(fetchUrl(u('/pdf'), opts()), 'url_unsupported_content', 422);
  });
  it('rejects oversized responses by declared length and while streaming', async () => {
    await expectCode(fetchUrl(u('/big'), opts()), 'url_fetch_failed');
    await expectCode(fetchUrl(u('/big-stream'), opts({ maxBytes: 10_000 })), 'url_fetch_failed');
  });
  it('times out', async () => {
    const err = await expectCode(fetchUrl(u('/slow'), opts({ timeoutMs: 300 })), 'url_fetch_failed');
    expect(err.message).toMatch(/timed out/i);
  });
  it('enforces a total deadline against a slow-drip body and cancels the request', async () => {
    const started = Date.now();
    const err = await expectCode(fetchUrl(u('/drip'), opts({ timeoutMs: 400, maxBytes: 1_000_000 })), 'url_fetch_failed');
    const elapsed = Date.now() - started;
    expect(err.message).toMatch(/timed out/i);
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(1500);
    await waitFor(() => closedPaths.includes('/drip'));
  });

  it('counts time spent across redirect hops against the same deadline', async () => {
    // Each hop takes ~150ms and redirects to itself; the deadline must fire before the redirect limit.
    const err = await expectCode(fetchUrl(u('/slow-hop'), opts({ timeoutMs: 400, maxRedirects: 10 })), 'url_fetch_failed');
    expect(err.message).toMatch(/timed out/i);
  });

  it('times out a DNS lookup that never answers', async () => {
    const started = Date.now();
    const err = await expectCode(fetchUrl(u('/page'), opts({ timeoutMs: 300, resolve: () => new Promise<string[]>(() => {}) })), 'url_fetch_failed');
    expect(err.message).toMatch(/resolving/i);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('closes redirect and error responses instead of draining a slow body in the background', async () => {
    const doc = await fetchUrl(u('/drip-redirect'), opts({ timeoutMs: 2000 }));
    expect(doc.body).toContain('hello world');
    await expectCode(fetchUrl(u('/drip-500'), opts({ timeoutMs: 2000 })), 'url_fetch_failed');
    await waitFor(() => closedPaths.includes('/drip-redirect') && closedPaths.includes('/drip-500'));
  });

  it('blocks hosts that resolve to private addresses before connecting', async () => {
    await expectCode(fetchUrl(u('/page', 'internal.test'), opts()), 'url_blocked', 422);
    await expectCode(fetchUrl(u('/page', 'meta.test'), opts()), 'url_blocked', 422);
    await expectCode(fetchUrl(u('/page', 'v6.test'), opts()), 'url_blocked', 422);
  });
  it('blocks when any resolved address is private (multi-answer DNS)', async () => {
    await expectCode(fetchUrl(u('/page'), opts({ resolve: async () => ['127.0.0.1', '10.0.0.1'] })), 'url_blocked');
  });
  it('fails cleanly for unresolvable hosts', async () => {
    const err = await expectCode(fetchUrl(u('/page', 'nope.test'), opts()), 'url_fetch_failed');
    expect(err.retryable).toBe(false);
  });
  it('follows a same-host redirect', async () => {
    const doc = await fetchUrl(u('/redirect-ok'), opts());
    expect(doc.body).toContain('hello world');
    expect(doc.redirects).toBe(1);
  });
  it('re-validates redirect targets (internal host, file scheme, loop, missing location)', async () => {
    await expectCode(fetchUrl(u('/redirect-internal'), opts()), 'url_blocked');
    await expectCode(fetchUrl(u('/redirect-file'), opts()), 'validation_error');
    const loop = await expectCode(fetchUrl(u('/redirect-loop'), opts()), 'url_fetch_failed');
    expect(loop.message).toMatch(/too many redirects/i);
    await expectCode(fetchUrl(u('/redirect-noloc'), opts()), 'url_fetch_failed');
  });
  it('maps HTTP error statuses and marks only 5xx retryable', async () => {
    expect((await expectCode(fetchUrl(u('/500'), opts()), 'url_fetch_failed')).retryable).toBe(true);
    expect((await expectCode(fetchUrl(u('/404'), opts()), 'url_fetch_failed')).retryable).toBe(false);
  });
  it('reports connection refused', async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const p = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const err = await expectCode(fetchUrl(`http://public.test:${p}/`, opts()), 'url_fetch_failed');
    expect(err.message).toMatch(/refused/i);
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}
