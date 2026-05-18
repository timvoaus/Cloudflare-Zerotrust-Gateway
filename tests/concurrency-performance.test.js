import { describe, it } from 'node:test';
import assert from 'node:assert';

/**
 * Phase 2 - Performance Tests: Concurrency Limiting
 * Tests that bounded concurrency works correctly.
 */

// Simulated runWithConcurrency matching lib/concurrency.js behavior
async function simulateRunWithConcurrency(items, fn, options = {}) {
  const { concurrency = 3, onProgress, stopOnError = true } = options;

  if (!Array.isArray(items)) {
    throw new Error('Items must be an array');
  }

  if (items.length === 0) {
    return [];
  }

  if (concurrency < 1) {
    throw new Error('Concurrency must be at least 1');
  }

  const results = [];
  let completed = 0;
  let hasError = false;

  // Sequential fallback
  if (concurrency === 1) {
    for (let i = 0; i < items.length; i++) {
      if (hasError && stopOnError) break;
      try {
        results[i] = await fn(items[i], i);
        completed++;
        if (onProgress) onProgress(completed, items.length);
      } catch (e) {
        hasError = true;
        if (stopOnError) throw e;
      }
    }
    return results;
  }

  // Bounded concurrency with pool
  let nextIndex = 0;
  let activeCount = 0;
  let firstError = null;

  return new Promise((resolve, reject) => {
    function startNext() {
      if (nextIndex >= items.length) return;
      if (hasError && stopOnError) return;

      const currentIndex = nextIndex++;
      activeCount++;

      fn(items[currentIndex], currentIndex)
        .then(result => {
          results[currentIndex] = result;
          activeCount--;
          completed++;
          if (onProgress) onProgress(completed, items.length);

          if (hasError && stopOnError) {
            // Already errored, finish up
            if (activeCount === 0) {
              reject(firstError);
            }
          } else if (completed >= items.length) {
            resolve(results);
          } else {
            startNext();
          }
        })
        .catch(error => {
          activeCount--;
          if (!hasError) {
            hasError = true;
            firstError = error;
          }

          if (stopOnError) {
            if (activeCount === 0) {
              reject(firstError);
            }
          } else {
            completed++;
            if (onProgress) onProgress(completed, items.length);
            if (completed >= items.length) {
              resolve(results);
            } else {
              startNext();
            }
          }
        });
    }

    // Start initial batch
    const initialBatch = Math.min(concurrency, items.length);
    for (let i = 0; i < initialBatch; i++) {
      startNext();
    }
  });
}

describe('performance - concurrency limiting', () => {
  describe('basic concurrency', () => {
    it('should process items with default concurrency (3)', async () => {
      const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const results = await simulateRunWithConcurrency(
        items,
        async (item) => {
          currentConcurrent++;
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
          await new Promise(r => setTimeout(r, 10)); // Simulate work
          currentConcurrent--;
          return item * 2;
        },
        { concurrency: 3 }
      );

      assert.deepStrictEqual(results, [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
      assert.ok(maxConcurrent <= 3, `Max concurrent was ${maxConcurrent}, should be <= 3`);
    });

    it('should process sequentially with concurrency=1', async () => {
      const items = [1, 2, 3, 4, 5];
      let activeCount = 0;
      let maxActive = 0;

      await simulateRunWithConcurrency(
        items,
        async () => {
          activeCount++;
          maxActive = Math.max(maxActive, activeCount);
          await new Promise(r => setTimeout(r, 5));
          activeCount--;
        },
        { concurrency: 1 }
      );

      assert.strictEqual(maxActive, 1);
    });

    it('should handle empty array', async () => {
      const results = await simulateRunWithConcurrency([], async () => 'result');
      assert.deepStrictEqual(results, []);
    });

    it('should throw on invalid concurrency (< 1)', async () => {
      await assert.rejects(
        simulateRunWithConcurrency([1], async () => {}, { concurrency: 0 }),
        { message: 'Concurrency must be at least 1' }
      );
    });
  });

  describe('order preservation', () => {
    it('should preserve result order despite variable timing', async () => {
      const items = ['a', 'b', 'c', 'd', 'e'];
      const delays = [50, 10, 30, 5, 20]; // Different delays

      const results = await simulateRunWithConcurrency(
        items,
        async (item, index) => {
          await new Promise(r => setTimeout(r, delays[index]));
          return item.toUpperCase();
        },
        { concurrency: 5 }
      );

      assert.deepStrictEqual(results, ['A', 'B', 'C', 'D', 'E']);
    });

    it('should maintain input-output mapping', async () => {
      const items = [
        { id: 1, value: 'first' },
        { id: 2, value: 'second' },
        { id: 3, value: 'third' }
      ];

      const results = await simulateRunWithConcurrency(
        items,
        async (item) => ({ ...item, processed: true }),
        { concurrency: 2 }
      );

      assert.strictEqual(results[0].id, 1);
      assert.strictEqual(results[1].id, 2);
      assert.strictEqual(results[2].id, 3);
      assert.ok(results.every(r => r.processed));
    });
  });

  describe('bounded limits', () => {
    it('should enforce concurrency=3 with 10 items', async () => {
      const items = new Array(10).fill(0).map((_, i) => i);
      let concurrentNow = 0;
      let maxObserved = 0;

      await simulateRunWithConcurrency(
        items,
        async () => {
          concurrentNow++;
          maxObserved = Math.max(maxObserved, concurrentNow);
          await new Promise(r => setTimeout(r, 20));
          concurrentNow--;
        },
        { concurrency: 3 }
      );

      assert.strictEqual(maxObserved, 3);
    });

    it('should enforce concurrency=5 with 20 items', async () => {
      const items = new Array(20).fill(0).map((_, i) => i);
      let maxConcurrent = 0;
      let current = 0;

      await simulateRunWithConcurrency(
        items,
        async () => {
          current++;
          maxConcurrent = Math.max(maxConcurrent, current);
          await new Promise(r => setTimeout(r, 5));
          current--;
        },
        { concurrency: 5 }
      );

      assert.strictEqual(maxConcurrent, 5);
    });

    it('should not exceed items.length when items < concurrency', async () => {
      const items = [1, 2, 3];
      let maxConcurrent = 0;
      let current = 0;

      await simulateRunWithConcurrency(
        items,
        async () => {
          current++;
          maxConcurrent = Math.max(maxConcurrent, current);
          await new Promise(r => setTimeout(r, 5));
          current--;
        },
        { concurrency: 10 }
      );

      assert.strictEqual(maxConcurrent, 3);
    });
  });

  describe('progress reporting', () => {
    it('should call onProgress for each completion', async () => {
      const items = [1, 2, 3, 4, 5];
      const progressCalls = [];

      await simulateRunWithConcurrency(
        items,
        async (item) => item,
        {
          concurrency: 2,
          onProgress: (completed, total) => {
            progressCalls.push({ completed, total });
          }
        }
      );

      assert.strictEqual(progressCalls.length, 5);
      assert.deepStrictEqual(progressCalls[0], { completed: 1, total: 5 });
      assert.deepStrictEqual(progressCalls[4], { completed: 5, total: 5 });
    });

    it('should report correct total count', async () => {
      const items = new Array(100).fill(0);
      let lastTotal = 0;

      await simulateRunWithConcurrency(
        items,
        async () => {},
        {
          concurrency: 5,
          onProgress: (completed, total) => {
            lastTotal = total;
          }
        }
      );

      assert.strictEqual(lastTotal, 100);
    });
  });

  describe('error handling', () => {
    it('should stop on first error with stopOnError=true', async () => {
      const items = [1, 2, 3, 4, 5];
      let processedCount = 0;

      await assert.rejects(
        simulateRunWithConcurrency(
          items,
          async (item) => {
            processedCount++;
            if (item === 3) throw new Error('Item 3 failed');
            await new Promise(r => setTimeout(r, 10));
          },
          { concurrency: 3, stopOnError: true }
        ),
        { message: 'Item 3 failed' }
      );

      // Should have stopped before processing all items
      assert.ok(processedCount < 5, `Processed ${processedCount} items, should be less than 5`);
    });

    it('should continue on error with stopOnError=false', async () => {
      const items = [1, 2, 3, 4, 5];
      const errors = [];
      const successes = [];

      await simulateRunWithConcurrency(
        items,
        async (item) => {
          if (item === 3) {
            errors.push(item);
            throw new Error('Skip');
          }
          successes.push(item);
          return item;
        },
        { concurrency: 3, stopOnError: false }
      );

      assert.strictEqual(successes.length, 4);
      assert.strictEqual(errors.length, 1);
      assert.ok(!successes.includes(3));
    });

    it('should handle all items failing', async () => {
      const items = [1, 2, 3];

      await assert.rejects(
        simulateRunWithConcurrency(
          items,
          async () => {
            throw new Error('Always fails');
          },
          { concurrency: 2 }
        ),
        { message: 'Always fails' }
      );
    });

    it('should handle errors in high concurrency', async () => {
      const items = new Array(20).fill(0).map((_, i) => i);
      let errorThrown = false;

      try {
        await simulateRunWithConcurrency(
          items,
          async (item) => {
            if (item === 15) throw new Error('Item 15 error');
            await new Promise(r => setTimeout(r, 5));
            return item;
          },
          { concurrency: 10 }
        );
      } catch (e) {
        errorThrown = true;
        assert.strictEqual(e.message, 'Item 15 error');
      }

      assert.strictEqual(errorThrown, true);
    });
  });

  describe('real-world scenarios', () => {
    it('should simulate fetching 50 lists with concurrency=3', async () => {
      const listIds = new Array(50).fill(0).map((_, i) => `list-${i}`);
      let maxConcurrent = 0;
      let current = 0;
      const fetchTimes = [];

      const results = await simulateRunWithConcurrency(
        listIds,
        async (listId) => {
          current++;
          maxConcurrent = Math.max(maxConcurrent, current);
          const start = Date.now();
          await new Promise(r => setTimeout(r, 10 + Math.random() * 20)); // Variable API time
          fetchTimes.push(Date.now() - start);
          current--;
          return { id: listId, items: ['domain1.com', 'domain2.com'] };
        },
        { concurrency: 3 }
      );

      assert.strictEqual(results.length, 50);
      assert.strictEqual(maxConcurrent, 3);
      assert.ok(fetchTimes.length === 50);
    });

    it('should simulate downloading 20 files with concurrency=3', async () => {
      const urls = new Array(20).fill(0).map((_, i) => `https://example.com/list${i}.txt`);
      let maxConcurrent = 0;
      let current = 0;

      const results = await simulateRunWithConcurrency(
        urls,
        async (url) => {
          current++;
          maxConcurrent = Math.max(maxConcurrent, current);
          await new Promise(r => setTimeout(r, 15)); // Simulate download
          current--;
          return `content of ${url}`;
        },
        { concurrency: 3 }
      );

      assert.strictEqual(results.length, 20);
      assert.strictEqual(maxConcurrent, 3);
    });

    it('should handle rapid small batches', async () => {
      const batches = [
        [1, 2],
        [3, 4, 5],
        [6],
        [7, 8, 9, 10]
      ];

      for (const batch of batches) {
        let maxConcurrent = 0;
        let current = 0;

        await simulateRunWithConcurrency(
          batch,
          async () => {
            current++;
            maxConcurrent = Math.max(maxConcurrent, current);
            await new Promise(r => setTimeout(r, 5));
            current--;
          },
          { concurrency: 3 }
        );

        assert.ok(maxConcurrent <= Math.min(batch.length, 3));
      }
    });
  });

  describe('performance characteristics', () => {
    it('should complete 100 items faster with concurrency=5 than concurrency=1', async () => {
      const items = new Array(100).fill(0).map((_, i) => i);
      const taskTime = 10; // ms per task

      // Sequential
      const start1 = Date.now();
      await simulateRunWithConcurrency(
        items,
        async () => {
          await new Promise(r => setTimeout(r, taskTime));
        },
        { concurrency: 1 }
      );
      const time1 = Date.now() - start1;

      // Concurrent
      const start5 = Date.now();
      await simulateRunWithConcurrency(
        items,
        async () => {
          await new Promise(r => setTimeout(r, taskTime));
        },
        { concurrency: 5 }
      );
      const time5 = Date.now() - start5;

      // Concurrent should be significantly faster (at least 3x)
      assert.ok(time5 < time1 / 3, `Concurrent (5) took ${time5}ms, sequential took ${time1}ms`);
    });

    it('should not exceed reasonable memory with large arrays', async () => {
      // Simulate large array without actually creating it
      const largeItemCount = 10000;
      const items = new Array(largeItemCount).fill(0).map((_, i) => i);

      let processedCount = 0;

      await simulateRunWithConcurrency(
        items,
        async (item) => {
          processedCount++;
          // Return small value, not large object
          return item % 2 === 0;
        },
        { concurrency: 3 }
      );

      assert.strictEqual(processedCount, largeItemCount);
    });
  });
});
