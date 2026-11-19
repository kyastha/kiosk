import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function transact(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
  const migrations = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
  for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    const version = Number(file.split('_')[0]);
    transact(db, () => {
      if (db.prepare('PRAGMA user_version').get().user_version >= version) return;
      db.exec(readFileSync(join(migrations, file), 'utf8'));
      db.exec(`PRAGMA user_version=${version}`);
    });
  }
  return db;
}

export function audit(db, actor, action, orderId = null, detail = {}) {
  db.prepare('INSERT INTO audit_logs (actor, action, order_id, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(actor, action, orderId, JSON.stringify(detail), Date.now());
}
