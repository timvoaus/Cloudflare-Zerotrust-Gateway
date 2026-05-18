import { describe, it } from 'node:test';
import assert from 'node:assert';
import { safeEqual, parseBasicAuth } from '../lib/server/dashboard-auth.js';

describe('dashboard-auth', () => {
  describe('safeEqual', () => {
    it('returns true for matching strings', () => {
      assert.strictEqual(safeEqual('password', 'password'), true);
    });

    it('returns false for different strings', () => {
      assert.strictEqual(safeEqual('password', 'wrong'), false);
    });

    it('returns false for different length strings', () => {
      assert.strictEqual(safeEqual('pass', 'password'), false);
    });
  });

  describe('parseBasicAuth', () => {
    it('extracts credentials from valid Basic auth header', () => {
      const header = 'Basic ' + Buffer.from('admin:secret').toString('base64');
      const creds = parseBasicAuth({ headers: { authorization: header } });
      assert.deepStrictEqual(creds, { username: 'admin', password: 'secret' });
    });

    it('returns null for missing header', () => {
      const creds = parseBasicAuth({ headers: {} });
      assert.strictEqual(creds, null);
    });

    it('returns null for non-Basic auth', () => {
      const creds = parseBasicAuth({ headers: { authorization: 'Bearer token123' } });
      assert.strictEqual(creds, null);
    });
  });
});
