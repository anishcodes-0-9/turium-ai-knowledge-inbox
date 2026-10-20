import pino, { type Logger } from 'pino';

/**
 * Structured JSON logger. In development the output is pretty-printed; in any
 * other environment it stays as newline-delimited JSON for log shippers.
 * Secrets are never logged: the AI key only lives in config and the provider.
 */
export function createLogger(level: string, nodeEnv: string): Logger {
  const pretty = nodeEnv === 'development';
  return pino({
    level,
    base: { service: 'inbox-server' },
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], remove: true },
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' } } }
      : {}),
  });
}

export type { Logger };
