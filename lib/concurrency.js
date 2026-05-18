/**
 * Bounded concurrency utility for Cloudflare Gateway API operations.
 * Processes items with limited parallelism to respect rate limits.
 */

/**
 * Runs an async function over an array of items with bounded concurrency.
 * Preserves result order. Stops on first error by default.
 * @template T
 * @template R
 * @param {T[]} items - Array of items to process
 * @param {(item: T, index: number) => Promise<R>} fn - Async function to apply to each item
 * @param {Object} options - Options
 * @param {number} [options.concurrency=3] - Max concurrent operations
 * @param {(completed: number, total: number) => void} [options.onProgress] - Progress callback
 * @param {boolean} [options.stopOnError=true] - Whether to stop on first error
 * @returns {Promise<R[]>} - Array of results in same order as input
 */
export async function runWithConcurrency(items, fn, options = {}) {
  const {
    concurrency = 3,
    onProgress,
    stopOnError = true,
  } = options;

  if (!Array.isArray(items)) {
    throw new TypeError('Expected items to be an array');
  }

  if (items.length === 0) {
    return [];
  }

  if (concurrency < 1) {
    throw new Error('Concurrency must be at least 1');
  }

  const results = new Array(items.length);
  let completed = 0;
  let hasError = false;
  let firstError = null;

  // Simple sequential fallback for concurrency = 1
  if (concurrency === 1) {
    for (let i = 0; i < items.length; i++) {
      if (hasError && stopOnError) break;
      
      try {
        results[i] = await fn(items[i], i);
        completed++;
        if (onProgress) {
          onProgress(completed, items.length);
        }
      } catch (err) {
        hasError = true;
        firstError = err;
        if (stopOnError) break;
        results[i] = err;
      }
    }
    
    if (hasError && stopOnError) {
      throw firstError;
    }
    return results;
  }

  // Bounded concurrency with pool
  return new Promise((resolve, reject) => {
    let nextIndex = 0;
    let activeCount = 0;
    let settledCount = 0;

    function startNext() {
      if (hasError && stopOnError) return;
      if (nextIndex >= items.length) return;

      const currentIndex = nextIndex;
      nextIndex++;
      activeCount++;

      fn(items[currentIndex], currentIndex)
        .then((result) => {
          results[currentIndex] = result;
        })
        .catch((err) => {
          hasError = true;
          firstError = err;
          results[currentIndex] = err;
        })
        .finally(() => {
          activeCount--;
          settledCount++;
          completed++;

          if (onProgress && !hasError) {
            onProgress(completed, items.length);
          }

          if (hasError && stopOnError) {
            // Wait for all active to settle, then reject
            if (activeCount === 0) {
              reject(firstError);
            }
            return;
          }

          if (settledCount === items.length) {
            resolve(results);
            return;
          }

          // Start next if available
          if (nextIndex < items.length && !(hasError && stopOnError)) {
            startNext();
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

/**
 * Maps an array with bounded concurrency.
 * Convenience wrapper around runWithConcurrency.
 * @template T
 * @template R
 * @param {T[]} items - Array to map
 * @param {(item: T, index: number) => Promise<R>} fn - Async mapper function
 * @param {Object} options - Options (same as runWithConcurrency)
 * @returns {Promise<R[]>} - Mapped results
 */
export function mapWithConcurrency(items, fn, options) {
  return runWithConcurrency(items, fn, options);
}
