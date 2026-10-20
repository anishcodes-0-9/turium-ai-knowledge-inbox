import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import { isPublicIp } from './ipPolicy.js';

export interface FetchOptions {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  /** Test hook: replaces DNS resolution. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Test hook: replaces the public-IP policy (never set in production code paths). */
  ipPolicy?: (ip: string) => boolean;
}

export interface FetchedDocument {
  finalUrl: string;
  contentType: string;
  body: string;
  bytes: number;
  redirects: number;
}

const ALLOWED_CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.onion'];
const USER_AGENT = 'AIKnowledgeInbox/1.0 (+server-side content fetcher)';

/**
 * Validates a user-supplied URL before any network activity.
 * Rejects: non-http(s) schemes, embedded credentials, empty/suspicious hosts,
 * and literal IP addresses that are not public.
 */
export function validateUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AppError('validation_error', 'URL is not valid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('validation_error', `Unsupported URL scheme "${url.protocol.replace(':', '')}"; only http and https are allowed`);
  }
  if (url.username || url.password) throw new AppError('validation_error', 'URLs with embedded credentials are not allowed');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) throw new AppError('validation_error', 'URL must include a hostname');
  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new AppError('url_blocked', 'URL points to a local or internal host, which is not allowed');
  }
  const literal = host.startsWith('[') ? host.slice(1, -1) : host;
  if (isIP(literal) && !isPublicIp(literal)) {
    throw new AppError('url_blocked', 'URL points to a private, loopback or reserved IP address, which is not allowed');
  }
  if (!isIP(literal) && !/^[a-z0-9.-]+$/.test(host)) throw new AppError('validation_error', 'URL hostname contains unsupported characters');
  return url;
}

/**
 * Fetches a URL safely:
 *  - every hop (initial + each redirect) is validated with `validateUrl`
 *  - the hostname is resolved up front and *all* resolved addresses must be public
 *  - the TCP connection is pinned to the validated address (custom `lookup`), so a
 *    DNS rebinding between validation and connection cannot change the target
 *  - total timeout, byte cap and content-type allow-list are enforced while streaming
 */
export async function fetchUrl(rawUrl: string, opts: FetchOptions, log?: Logger): Promise<FetchedDocument> {
  const deadline = Date.now() + opts.timeoutMs;
  let url = validateUrl(rawUrl);
  for (let redirects = 0; ; redirects++) {
    const address = await resolveValidatedAddress(url, opts);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new AppError('url_fetch_failed', 'Timed out while fetching the URL');
    const res = await requestOnce(url, address, { ...opts, timeoutMs: remaining });
    if (res.kind === 'redirect') {
      if (redirects >= opts.maxRedirects) throw new AppError('url_fetch_failed', `Too many redirects (limit ${opts.maxRedirects})`);
      let next: URL;
      try {
        next = new URL(res.location, url);
      } catch {
        throw new AppError('url_fetch_failed', 'Received an invalid redirect location');
      }
      log?.debug({ from: url.href, to: next.href }, 'following redirect');
      url = validateUrl(next.href); // re-validate every hop
      continue;
    }
    return { ...res.doc, redirects };
  }
}

async function resolveValidatedAddress(url: URL, opts: FetchOptions): Promise<{ ip: string; family: 4 | 6 }> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = opts.resolve ? await opts.resolve(host) : (await dnsLookup(host, { all: true })).map((a) => a.address);
    } catch {
      throw new AppError('url_fetch_failed', `Could not resolve hostname "${host}"`, { retryable: false });
    }
  }
  if (addresses.length === 0) throw new AppError('url_fetch_failed', `Hostname "${host}" has no addresses`, { retryable: false });
  const allowed = opts.ipPolicy ?? isPublicIp;
  if (addresses.some((a) => !allowed(a))) {
    throw new AppError('url_blocked', 'URL resolves to a private, loopback or reserved address, which is not allowed');
  }
  const ip = addresses[0]!;
  return { ip, family: isIP(ip) === 6 ? 6 : 4 };
}

type RequestResult = { kind: 'redirect'; location: string } | { kind: 'document'; doc: Omit<FetchedDocument, 'redirects'> };

function requestOnce(url: URL, address: { ip: string; family: 4 | 6 }, opts: FetchOptions): Promise<RequestResult> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9', 'accept-encoding': 'identity' },
        // Pin the socket to the address we validated; keeps SNI/Host on the original hostname.
        lookup: (_host, _options, cb) => cb(null, [{ address: address.ip, family: address.family }] as never),
        servername: url.protocol === 'https:' && !isIP(hostname) ? hostname : undefined,
        timeout: opts.timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          const location = res.headers.location;
          if (!location) return reject(new AppError('url_fetch_failed', 'Redirect response had no Location header'));
          return resolve({ kind: 'redirect', location });
        }
        if (status < 200 || status >= 300) {
          res.resume();
          return reject(new AppError('url_fetch_failed', `Remote server responded with HTTP ${status}`, { retryable: status >= 500 }));
        }
        const rawType = (res.headers['content-type'] ?? '').toLowerCase();
        const mediaType = rawType.split(';')[0]!.trim();
        if (!ALLOWED_CONTENT_TYPES.includes(mediaType)) {
          res.resume();
          return reject(new AppError('url_unsupported_content', `Unsupported content type "${mediaType || 'unknown'}"; only HTML and plain text pages can be saved`));
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > opts.maxBytes) {
          res.resume();
          return reject(new AppError('url_fetch_failed', `Page is too large (${declared} bytes; limit ${opts.maxBytes})`, { retryable: false }));
        }
        const chunks: Buffer[] = [];
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > opts.maxBytes) {
            req.destroy(new AppError('url_fetch_failed', `Page is too large (limit ${opts.maxBytes} bytes)`, { retryable: false }));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const charset = /charset=([^;]+)/.exec(rawType)?.[1]?.trim().replace(/^"|"$/g, '') || 'utf-8';
          let body: string;
          try {
            body = new TextDecoder(charset).decode(Buffer.concat(chunks));
          } catch {
            body = Buffer.concat(chunks).toString('utf-8');
          }
          resolve({ kind: 'document', doc: { finalUrl: url.href, contentType: mediaType, body, bytes: received } });
        });
        res.on('error', (err) => reject(wrapNetworkError(err)));
      },
    );
    req.on('timeout', () => req.destroy(new AppError('url_fetch_failed', 'Timed out while fetching the URL')));
    req.on('error', (err) => reject(wrapNetworkError(err)));
    req.end();
  });
}

function wrapNetworkError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const code = (err as NodeJS.ErrnoException)?.code;
  const message = code === 'ECONNREFUSED' ? 'Connection refused by the remote server' : code === 'ENOTFOUND' ? 'Hostname could not be resolved' : 'Network error while fetching the URL';
  return new AppError('url_fetch_failed', message, { cause: err });
}
