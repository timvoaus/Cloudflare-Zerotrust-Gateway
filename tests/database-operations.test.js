import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Database Operations Tests
 * Tests SQLite operations used throughout the application.
 */

describe('database operations', () => {
  let db;
  let testDbPath;

  beforeEach(() => {
    testDbPath = join(tmpdir(), `czgs-test-${Date.now()}.db`);
    db = new DatabaseSync(testDbPath);
  });

  afterEach(() => {
    if (db) db.close();
    try { rmSync(testDbPath); } catch {}
  });

  describe('table creation', () => {
    it('should create logs table with correct schema', () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS logs (
          query_id TEXT PRIMARY KEY,
          datetime INTEGER,
          src_country TEXT,
          src_country_code TEXT,
          source_ip TEXT,
          resolved_ips TEXT
        )
      `);

      const insert = db.prepare('INSERT INTO logs (query_id, datetime) VALUES (?, ?)');
      insert.run('test-123', 1234567890);

      const result = db.prepare('SELECT * FROM logs WHERE query_id = ?').get('test-123');
      assert.strictEqual(result.query_id, 'test-123');
      assert.strictEqual(result.datetime, 1234567890);
    });

    it('should create sync_state table', () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_state (
          key TEXT PRIMARY KEY,
          last_synced_ts INTEGER,
          oldest_synced_ts INTEGER
        )
      `);

      const insert = db.prepare('INSERT INTO sync_state VALUES (?, ?, ?)');
      insert.run('traffic_map', 1000000, 900000);

      const result = db.prepare('SELECT * FROM sync_state WHERE key = ?').get('traffic_map');
      assert.strictEqual(result.last_synced_ts, 1000000);
    });
  });

  describe('insert operations', () => {
    beforeEach(() => {
      db.exec(`CREATE TABLE logs (query_id TEXT PRIMARY KEY, datetime INTEGER)`);
    });

    it('should insert single row', () => {
      const insert = db.prepare('INSERT INTO logs VALUES (?, ?)');
      insert.run('query-1', 1000);

      const result = db.prepare('SELECT COUNT(*) as cnt FROM logs').get();
      assert.strictEqual(result.cnt, 1);
    });

    it('should handle INSERT OR IGNORE for duplicates', () => {
      const insert = db.prepare('INSERT OR IGNORE INTO logs VALUES (?, ?)');
      insert.run('dup', 1000);
      insert.run('dup', 2000);

      const result = db.prepare('SELECT * FROM logs WHERE query_id = ?').get('dup');
      assert.strictEqual(result.datetime, 1000);
    });

    it('should handle INSERT OR REPLACE for updates', () => {
      const insert = db.prepare('INSERT OR REPLACE INTO logs VALUES (?, ?)');
      insert.run('replace', 1000);
      insert.run('replace', 2000);

      const result = db.prepare('SELECT * FROM logs WHERE query_id = ?').get('replace');
      assert.strictEqual(result.datetime, 2000);
    });

    it('should insert batch in transaction', () => {
      const insert = db.prepare('INSERT INTO logs VALUES (?, ?)');

      db.exec('BEGIN');
      for (let i = 0; i < 100; i++) {
        insert.run(`batch-${i}`, 1000 + i);
      }
      db.exec('COMMIT');

      assert.strictEqual(db.prepare('SELECT COUNT(*) as cnt FROM logs').get().cnt, 100);
    });
  });

  describe('transaction handling', () => {
    beforeEach(() => {
      db.exec(`CREATE TABLE logs (query_id TEXT PRIMARY KEY, datetime INTEGER)`);
    });

    it('should commit successful transaction', () => {
      db.exec('BEGIN');
      const insert = db.prepare('INSERT INTO logs VALUES (?, ?)');
      insert.run('a', 1);
      insert.run('b', 2);
      db.exec('COMMIT');

      assert.strictEqual(db.prepare('SELECT COUNT(*) as cnt FROM logs').get().cnt, 2);
    });

    it('should rollback failed transaction', () => {
      try {
        db.exec('BEGIN');
        const insert = db.prepare('INSERT INTO logs VALUES (?, ?)');
        insert.run('a', 1);
        insert.run('a', 2); // Duplicate
        db.exec('COMMIT');
      } catch {
        db.exec('ROLLBACK');
      }

      assert.strictEqual(db.prepare('SELECT COUNT(*) as cnt FROM logs').get().cnt, 0);
    });
  });

  describe('query operations', () => {
    beforeEach(() => {
      db.exec(`CREATE TABLE logs (query_id TEXT PRIMARY KEY, datetime INTEGER, country TEXT)`);
      const insert = db.prepare('INSERT INTO logs VALUES (?, ?, ?)');
      for (let i = 0; i < 10; i++) {
        insert.run(`q-${i}`, 1000 + i, i % 2 === 0 ? 'US' : 'UK');
      }
    });

    it('should query single row with get()', () => {
      const result = db.prepare('SELECT * FROM logs WHERE query_id = ?').get('q-5');
      assert.strictEqual(result.datetime, 1005);
    });

    it('should query multiple rows with all()', () => {
      const results = db.prepare('SELECT * FROM logs WHERE datetime >= ?').all(1005);
      assert.strictEqual(results.length, 5);
    });

    it('should handle aggregate queries', () => {
      const count = db.prepare('SELECT COUNT(*) as cnt FROM logs').get();
      assert.strictEqual(count.cnt, 10);

      const range = db.prepare('SELECT MIN(datetime), MAX(datetime) FROM logs').get();
      assert.strictEqual(range['MIN(datetime)'], 1000);
      assert.strictEqual(range['MAX(datetime)'], 1009);
    });
  });

  describe('sync state', () => {
    beforeEach(() => {
      db.exec(`CREATE TABLE sync_state (key TEXT PRIMARY KEY, last_synced_ts INTEGER)`);
    });

    it('should upsert sync state', () => {
      const upsert = db.prepare(`
        INSERT INTO sync_state VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET last_synced_ts = excluded.last_synced_ts
      `);
      upsert.run('traffic', 1000);
      upsert.run('traffic', 2000);

      const result = db.prepare('SELECT * FROM sync_state WHERE key = ?').get('traffic');
      assert.strictEqual(result.last_synced_ts, 2000);
    });
  });

  describe('retention cleanup', () => {
    beforeEach(() => {
      db.exec(`CREATE TABLE logs (query_id TEXT PRIMARY KEY, datetime INTEGER)`);
      const insert = db.prepare('INSERT INTO logs VALUES (?, ?)');
      const now = 10000000;
      for (let i = 0; i < 5; i++) {
        insert.run(`old-${i}`, now - 40 * 24 * 60 * 60);
        insert.run(`new-${i}`, now - 5 * 24 * 60 * 60);
      }
    });

    it('should delete old records based on retention', () => {
      const cutoff = 10000000 - 30 * 24 * 60 * 60;
      
      db.prepare('DELETE FROM logs WHERE datetime < ?').run(cutoff);
      
      assert.strictEqual(db.prepare('SELECT COUNT(*) as cnt FROM logs').get().cnt, 5);
    });
  });

  describe('health check', () => {
    it('should verify database is writable', () => {
      let writable = false;
      try {
        db.exec('CREATE TABLE _health (id INTEGER)');
        writable = true;
      } catch {}
      assert.strictEqual(writable, true);
    });
  });
});
