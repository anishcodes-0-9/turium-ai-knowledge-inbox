import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrations } from './schema.js';
import type { Logger } from '../logger.js';

export type Database = DatabaseSync;

/** Opens (creating if needed) the SQLite database and applies pending migrations. */
export function openDatabase(path: string, log?: Logger): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  runMigrations(db, log);
  return db;
}

export function runMigrations(db: Database, log?: Logger): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);');
  const applied = new Set((db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: number }>).map((r) => r.id));
  let count = 0;
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    count++;
    log?.info({ migration: m.id, name: m.name }, 'applied migration');
  }
  return count;
}

/** Runs `fn` inside a transaction; rolls back on any throw. */
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
