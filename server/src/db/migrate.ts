/** CLI entry: `npm run db:migrate` — creates the database file and applies migrations. */
import { loadDotEnv } from '../env.js';
loadDotEnv();
import { loadConfig } from '../config.js';
import { openDatabase } from './connection.js';

const cfg = loadConfig({ ...process.env, AI_API_KEY: process.env.AI_API_KEY || 'unused-for-migrate' });
const db = openDatabase(cfg.DATABASE_PATH);
const rows = db.prepare('SELECT id, name, applied_at FROM schema_migrations ORDER BY id').all();
console.log(`Database ready at ${cfg.DATABASE_PATH}`);
console.table(rows);
db.close();
