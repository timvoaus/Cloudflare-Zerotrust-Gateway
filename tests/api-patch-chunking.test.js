import { describe, it } from 'node:test';
import assert from 'node:assert';

/**
 * Tests for patch chunking behavior.
 * 
 * These tests simulate the patchExistingListChunked logic without
 * making real Cloudflare API calls.
 */

// Simulated chunking function that mimics patchExistingListChunked behavior
// Tests the logic without network calls
async function simulatePatchChunking(patch, chunkSize, patchFn) {
  const remove = patch.remove || [];
  const append = patch.append || [];

  if (remove.length === 0 && append.length === 0) {
    return { calls: 0, chunks: [] };
  }

  const totalRemoveChunks = Math.ceil(remove.length / chunkSize);
  const totalAppendChunks = Math.ceil(append.length / chunkSize);
  const totalChunks = totalRemoveChunks + totalAppendChunks;

  const calls = [];

  if (totalChunks <= 1) {
    // Small enough for single request
    await patchFn(patch);
    calls.push({ type: 'single', patch });
    return { calls: 1, chunks: calls };
  }

  let chunkNum = 1;

  // Process removals first (sequential)
  for (let i = 0; i < remove.length; i += chunkSize) {
    const chunk = { remove: remove.slice(i, i + chunkSize) };
    await patchFn(chunk);
    calls.push({ type: 'remove', chunkNum: chunkNum++, totalChunks, chunk });
  }

  // Process appends next (sequential)
  for (let i = 0; i < append.length; i += chunkSize) {
    const chunk = { append: append.slice(i, i + chunkSize) };
    await patchFn(chunk);
    calls.push({ type: 'append', chunkNum: chunkNum++, totalChunks, chunk });
  }

  return { calls: calls.length, chunks: calls };
}

describe('api - patchExistingListChunked', () => {
  describe('chunk splitting', () => {
    it('should split large append arrays correctly', async () => {
      const chunkSize = 3;
      const patch = {
        append: [
          { value: 'a.com' },
          { value: 'b.com' },
          { value: 'c.com' },
          { value: 'd.com' },
          { value: 'e.com' }
        ]
      };

      const callLog = [];
      const mockPatch = async (chunk) => {
        callLog.push(chunk);
      };

      const result = await simulatePatchChunking(patch, chunkSize, mockPatch);

      // Should make 2 calls: 3 items + 2 items
      assert.strictEqual(result.calls, 2);
      assert.strictEqual(callLog.length, 2);

      // First chunk: 3 items
      assert.strictEqual(callLog[0].append.length, 3);
      assert.strictEqual(callLog[0].append[0].value, 'a.com');
      assert.strictEqual(callLog[0].append[2].value, 'c.com');

      // Second chunk: 2 items
      assert.strictEqual(callLog[1].append.length, 2);
      assert.strictEqual(callLog[1].append[0].value, 'd.com');
      assert.strictEqual(callLog[1].append[1].value, 'e.com');
    });

    it('should split large remove arrays correctly', async () => {
      const chunkSize = 2;
      const patch = {
        remove: ['x.com', 'y.com', 'z.com', 'w.com']
      };

      const callLog = [];
      const mockPatch = async (chunk) => {
        callLog.push(chunk);
      };

      const result = await simulatePatchChunking(patch, chunkSize, mockPatch);

      // Should make 2 calls: 2 items + 2 items
      assert.strictEqual(result.calls, 2);

      // First chunk: remove x, y
      assert.deepStrictEqual(callLog[0].remove, ['x.com', 'y.com']);

      // Second chunk: remove z, w
      assert.deepStrictEqual(callLog[1].remove, ['z.com', 'w.com']);
    });

    it('should handle mixed append and remove in correct order', async () => {
      const chunkSize = 2;
      const patch = {
        remove: ['old1.com', 'old2.com', 'old3.com'],
        append: [
          { value: 'new1.com' },
          { value: 'new2.com' },
          { value: 'new3.com' }
        ]
      };

      const callLog = [];
      const mockPatch = async (chunk) => {
        callLog.push(chunk);
      };

      const result = await simulatePatchChunking(patch, chunkSize, mockPatch);

      // 2 remove chunks + 2 append chunks = 4 total
      assert.strictEqual(result.calls, 4);

      // Removals first
      assert.deepStrictEqual(callLog[0].remove, ['old1.com', 'old2.com']);
      assert.deepStrictEqual(callLog[1].remove, ['old3.com']);

      // Then appends
      assert.strictEqual(callLog[2].append.length, 2);
      assert.strictEqual(callLog[3].append.length, 1);
    });
  });

  describe('edge cases', () => {
    it('should use single request when under chunk size', async () => {
      const chunkSize = 10;
      const patch = {
        append: [{ value: 'a.com' }, { value: 'b.com' }]
        // Only append, no remove - counts as 1 chunk
      };

      const callLog = [];
      const mockPatch = async (chunk) => {
        callLog.push(chunk);
      };

      const result = await simulatePatchChunking(patch, chunkSize, mockPatch);

      // Single call when total chunks <= 1
      assert.strictEqual(result.calls, 1);
      assert.strictEqual(callLog.length, 1);
      assert.deepStrictEqual(callLog[0].append, patch.append);
    });

    it('should skip empty patches', async () => {
      const chunkSize = 5;
      const patch = {
        append: [],
        remove: []
      };

      let wasCalled = false;
      const mockPatch = async () => {
        wasCalled = true;
      };

      const result = await simulatePatchChunking(patch, chunkSize, mockPatch);

      assert.strictEqual(result.calls, 0);
      assert.strictEqual(wasCalled, false);
    });

    it('should handle empty append with non-empty remove', async () => {
      const chunkSize = 3;
      const patch = {
        remove: ['a.com', 'b.com', 'c.com', 'd.com'],
        append: []
      };

      const callLog = [];
      const mockPatch = async (chunk) => {
        callLog.push(chunk);
      };

      const result = await simulatePatchChunking(patch, chunkSize, mockPatch);

      // Only remove calls, no append
      assert.strictEqual(result.calls, 2);
      assert.strictEqual(callLog[0].remove.length, 3);
      assert.strictEqual(callLog[1].remove.length, 1);
      assert.strictEqual(callLog[0].append, undefined);
    });

    it('should handle exact chunk size boundary', async () => {
      const chunkSize = 3;
      const patch = {
        append: [
          { value: 'a.com' },
          { value: 'b.com' },
          { value: 'c.com' }
        ]
      };

      const callLog = [];
      const mockPatch = async (chunk) => {
        callLog.push(chunk);
      };

      const result = await simulatePatchChunking(patch, chunkSize, mockPatch);

      // Exactly at chunk size - should still be single call
      assert.strictEqual(result.calls, 1);
      assert.strictEqual(callLog[0].append.length, 3);
    });

    it('should handle just over chunk size boundary', async () => {
      const chunkSize = 3;
      const patch = {
        append: [
          { value: 'a.com' },
          { value: 'b.com' },
          { value: 'c.com' },
          { value: 'd.com' }
        ]
      };

      const callLog = [];
      const mockPatch = async (chunk) => {
        callLog.push(chunk);
      };

      const result = await simulatePatchChunking(patch, chunkSize, mockPatch);

      // Just over chunk size - needs 2 calls
      assert.strictEqual(result.calls, 2);
      assert.strictEqual(callLog[0].append.length, 3);
      assert.strictEqual(callLog[1].append.length, 1);
    });
  });

  describe('error handling', () => {
    it('should stop and report on first error', async () => {
      const chunkSize = 2;
      const patch = {
        append: [
          { value: 'a.com' },
          { value: 'b.com' },
          { value: 'c.com' },
          { value: 'd.com' }
        ]
      };

      let callCount = 0;
      const mockPatch = async (chunk) => {
        callCount++;
        if (callCount === 2) {
          throw new Error('Cloudflare API error: Rate limited');
        }
      };

      await assert.rejects(
        simulatePatchChunking(patch, chunkSize, mockPatch),
        { message: 'Cloudflare API error: Rate limited' }
      );

      // Should have stopped after error
      assert.strictEqual(callCount, 2);
    });

    it('should throw error immediately for single-chunk failure', async () => {
      const chunkSize = 10;
      const patch = {
        append: [{ value: 'a.com' }]
      };

      const mockPatch = async () => {
        throw new Error('Network timeout');
      };

      await assert.rejects(
        simulatePatchChunking(patch, chunkSize, mockPatch),
        { message: 'Network timeout' }
      );
    });

    it('should handle partial failure in sequential chunks', async () => {
      const chunkSize = 2;
      const patch = {
        remove: ['a.com', 'b.com'],
        append: [{ value: 'c.com' }, { value: 'd.com' }]
      };

      let callCount = 0;
      const callLog = [];
      const mockPatch = async (chunk) => {
        callCount++;
        callLog.push(chunk);
        if (callCount === 2) {
          throw new Error('API error on second chunk');
        }
      };

      await assert.rejects(
        simulatePatchChunking(patch, chunkSize, mockPatch),
        { message: 'API error on second chunk' }
      );

      // First chunk succeeded, second failed
      assert.strictEqual(callCount, 2);
      assert.deepStrictEqual(callLog[0].remove, ['a.com', 'b.com']);
      assert.deepStrictEqual(callLog[1].append, [{ value: 'c.com' }, { value: 'd.com' }]);
    });
  });

  describe('sequential processing', () => {
    it('should process chunks sequentially, not in parallel', async () => {
      const chunkSize = 2;
      const patch = {
        append: [
          { value: 'a.com' },
          { value: 'b.com' },
          { value: 'c.com' },
          { value: 'd.com' }
        ]
      };

      const executionOrder = [];
      const mockPatch = async (chunk) => {
        executionOrder.push(chunk.append[0].value);
      };

      await simulatePatchChunking(patch, chunkSize, mockPatch);

      // Should be in order, not interleaved
      assert.deepStrictEqual(executionOrder, ['a.com', 'c.com']);
    });

    it('should maintain order within chunks', async () => {
      const chunkSize = 3;
      const patch = {
        append: [
          { value: 'first.com' },
          { value: 'second.com' },
          { value: 'third.com' }
        ]
      };

      let capturedChunk = null;
      const mockPatch = async (chunk) => {
        capturedChunk = chunk;
      };

      await simulatePatchChunking(patch, chunkSize, mockPatch);

      // Order preserved
      assert.strictEqual(capturedChunk.append[0].value, 'first.com');
      assert.strictEqual(capturedChunk.append[1].value, 'second.com');
      assert.strictEqual(capturedChunk.append[2].value, 'third.com');
    });
  });
});
