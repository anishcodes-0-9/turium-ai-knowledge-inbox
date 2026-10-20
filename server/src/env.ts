import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Loads `.env` from the server directory if present (no-op otherwise). Uses Node's built-in loader. */
export function loadDotEnv(): void {
  const candidates = [resolve(process.cwd(), '.env'), resolve(process.cwd(), 'server', '.env')];
  for (const file of candidates) {
    if (existsSync(file)) {
      process.loadEnvFile(file);
      return;
    }
  }
}
