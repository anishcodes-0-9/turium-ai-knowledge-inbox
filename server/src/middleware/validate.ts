import type { ZodType } from 'zod';
import { AppError } from '../errors.js';

/** Parses `input` with `schema`, converting Zod issues into a 400 validation_error. */
export function parseOrThrow<T>(schema: ZodType<T>, input: unknown, what = 'request'): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message }));
  const first = issues[0];
  const summary = first ? `${first.path === '(root)' ? '' : `${first.path}: `}${first.message}` : 'invalid input';
  throw new AppError('validation_error', `Invalid ${what}: ${summary}`, { details: { issues } });
}
