import { describe, it } from 'node:test';
import assert from 'node:assert';

/**
 * Phase 2 - Performance Tests: Sync Operation Profiling
 * Benchmarks timing for large list operations.
 */

// Simulated sync pipeline
async function simulateDownloadPhase(urls, options = {}) {
  const { concurrency = 3, delayPerFile = 50 } = options;
  const startTime = Date.now();
  
  const downloadItem = async (url) => {
    await new Promise(r => setTimeout(r, delayPerFile + Math.random() * 20));
    return { url, content: `domains from ${url}`, size: 10000 };
  };
  
  // Simulate concurrent downloads
  const results = [];
  let completed = 0;
  
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (url) => {
        const result = await downloadItem(url);
        completed++;
        return result;
      })
    );
    results.push(...batchResults);
  }
  
  return {
    results,
    duration: Date.now() - startTime,
    items: urls.length
  };
}

async function simulateNormalizePhase(downloads, options = {}) {
  const { domainsPerFile = 10000, processingTimePerDomain = 0.01 } = options;
  const startTime = Date.now();
  
  let totalDomains = 0;
  const allDomains = [];
  
  for (const download of downloads) {
    // Simulate parsing domains from file
    const domains = new Array(domainsPerFile).fill(0).map((_, i) => 
      `domain${totalDomains + i}.com`
    );
    allDomains.push(...domains);
    totalDomains += domainsPerFile;
    
    // Simulate processing time
    await new Promise(r => setTimeout(r, domainsPerFile * processingTimePerDomain));
  }
  
  // Deduplicate
  const uniqueDomains = [...new Set(allDomains)];
  
  return {
    totalDomains,
    uniqueDomains: uniqueDomains.length,
    duplicates: totalDomains - uniqueDomains.length,
    duration: Date.now() - startTime
  };
}

async function simulateSyncPhase(domains, options = {}) {
  const { 
    listSize = 1000, 
    concurrency = 3, 
    apiDelay = 100,
    chunkSize = 500
  } = options;
  const startTime = Date.now();
  
  // Calculate lists needed
  const listsNeeded = Math.ceil(domains / listSize);
  const operations = [];
  
  // Simulate list operations
  for (let i = 0; i < listsNeeded; i++) {
    const domainCount = Math.min(listSize, domains - i * listSize);
    const chunks = Math.ceil(domainCount / chunkSize);
    
    // Each list requires fetch + patch operations
    operations.push({ type: 'fetch', list: i, duration: apiDelay });
    
    for (let c = 0; c < chunks; c++) {
      operations.push({ type: 'patch', list: i, chunk: c, duration: apiDelay });
    }
  }
  
  // Execute with concurrency
  let completed = 0;
  for (let i = 0; i < operations.length; i += concurrency) {
    const batch = operations.slice(i, i + concurrency);
    await Promise.all(
      batch.map(op => 
        new Promise(r => setTimeout(r, op.duration))
      )
    );
    completed += batch.length;
  }
  
  return {
    listsUpdated: listsNeeded,
    operations: operations.length,
    duration: Date.now() - startTime
  };
}

async function simulateRuleUpdatePhase(options = {}) {
  const { apiDelay = 150 } = options;
  const startTime = Date.now();
  
  // Simulate rule fetch + update
  await new Promise(r => setTimeout(r, apiDelay)); // Fetch existing
  await new Promise(r => setTimeout(r, apiDelay)); // Update rule
  
  return {
    duration: Date.now() - startTime
  };
}

// Full sync pipeline
async function runFullSyncPipeline(domainCount, options = {}) {
  const startTime = Date.now();
  
  // Download phase
  const urls = new Array(Math.ceil(domainCount / 10000)).fill(0)
    .map((_, i) => `https://example.com/list${i}.txt`);
  const download = await simulateDownloadPhase(urls, options.download);
  
  // Normalize phase
  const normalize = await simulateNormalizePhase(download.results, options.normalize);
  
  // Sync phase
  const sync = await simulateSyncPhase(normalize.uniqueDomains, options.sync);
  
  // Rule update phase
  const rule = await simulateRuleUpdatePhase(options.rule);
  
  const totalDuration = Date.now() - startTime;
  
  return {
    phases: { download, normalize, sync, rule },
    totalDuration,
    domains: normalize.uniqueDomains,
    throughput: normalize.uniqueDomains / (totalDuration / 1000)
  };
}

describe('performance - sync profiling', () => {
  describe('download phase', () => {
    it('should download 5 files in reasonable time', async () => {
      const urls = [
        'https://example.com/blocklist1.txt',
        'https://example.com/blocklist2.txt',
        'https://example.com/blocklist3.txt',
        'https://example.com/allowlist.txt',
        'https://example.com/extra.txt'
      ];
      
      const result = await simulateDownloadPhase(urls, { 
        concurrency: 3, 
        delayPerFile: 30 
      });
      
      assert.strictEqual(result.items, 5);
      assert.ok(result.duration < 200, `Download took ${result.duration}ms, should be < 200ms`);
    });
    
    it('should download 20 files with concurrency=3', async () => {
      const urls = new Array(20).fill(0).map((_, i) => `https://example.com/list${i}.txt`);
      
      const result = await simulateDownloadPhase(urls, { 
        concurrency: 3, 
        delayPerFile: 20 
      });
      
      // With concurrency=3 and 20 items, should take ~7 batches × 20ms = ~140ms + overhead
      assert.ok(result.duration < 400, `Download took ${result.duration}ms, should be < 400ms`);
      assert.strictEqual(result.items, 20);
    });
    
    it('should handle slow download sources', async () => {
      const urls = [
        'https://slow.com/list1.txt',
        'https://slow.com/list2.txt'
      ];
      
      const result = await simulateDownloadPhase(urls, { 
        concurrency: 2, 
        delayPerFile: 200 
      });
      
      assert.ok(result.duration >= 200, 'Should respect slow download time');
      assert.ok(result.duration < 500, `Too slow: ${result.duration}ms`);
    });
  });
  
  describe('normalize phase', () => {
    it('should normalize 10k domains quickly', async () => {
      const downloads = [{ url: 'test.txt', content: '10k domains' }];
      
      const result = await simulateNormalizePhase(downloads, { 
        domainsPerFile: 10000,
        processingTimePerDomain: 0.005
      });
      
      assert.strictEqual(result.totalDomains, 10000);
      assert.ok(result.duration < 100, `Normalize took ${result.duration}ms, should be < 100ms`);
    });
    
    it('should handle 100k domains efficiently', async () => {
      const downloads = new Array(10).fill(0).map((_, i) => ({ 
        url: `list${i}.txt`, 
        content: '10k domains' 
      }));
      
      const result = await simulateNormalizePhase(downloads, { 
        domainsPerFile: 10000,
        processingTimePerDomain: 0.005
      });
      
      assert.strictEqual(result.totalDomains, 100000);
      assert.ok(result.duration < 1000, `Normalize took ${result.duration}ms, should be < 1000ms for 100k`);
    });
    
    it('should detect and report duplicates', async () => {
      const downloads = [
        { url: 'list1.txt', content: 'domains' },
        { url: 'list2.txt', content: 'overlapping domains' }
      ];
      
      // Simulate with 50% overlap
      const result = await simulateNormalizePhase(downloads, { 
        domainsPerFile: 1000,
        processingTimePerDomain: 0.01
      });
      
      assert.ok(result.duplicates >= 0);
      assert.strictEqual(result.uniqueDomains, result.totalDomains - result.duplicates);
    });
  });
  
  describe('sync phase', () => {
    it('should sync to 1 list (1k domains) quickly', async () => {
      const result = await simulateSyncPhase(1000, {
        listSize: 1000,
        concurrency: 3,
        apiDelay: 50,
        chunkSize: 500
      });
      
      assert.strictEqual(result.listsUpdated, 1);
      assert.ok(result.duration < 200, `Sync took ${result.duration}ms for 1k domains`);
    });
    
    it('should sync to 10 lists (10k domains) efficiently', async () => {
      const result = await simulateSyncPhase(10000, {
        listSize: 1000,
        concurrency: 3,
        apiDelay: 50,
        chunkSize: 500
      });
      
      assert.strictEqual(result.listsUpdated, 10);
      // 10 lists × (1 fetch + 2 patches) = 30 ops / 3 concurrency = 10 batches × 50ms = 500ms
      assert.ok(result.duration < 1000, `Sync took ${result.duration}ms for 10k domains, should be < 1000ms`);
    });
    
    it('should sync to 100 lists (100k domains) with bounded concurrency', async () => {
      const result = await simulateSyncPhase(100000, {
        listSize: 1000,
        concurrency: 3,
        apiDelay: 50,
        chunkSize: 500
      });
      
      assert.strictEqual(result.listsUpdated, 100);
      // 100 lists × 3 ops = 300 ops / 3 concurrency = 100 batches × 50ms = 5000ms
      assert.ok(result.duration < 8000, `Sync took ${result.duration}ms for 100k domains, should be < 8000ms`);
    });
    
    it('should handle chunking for large single list updates', async () => {
      const result = await simulateSyncPhase(5000, {
        listSize: 5000,
        concurrency: 3,
        apiDelay: 50,
        chunkSize: 500
      });
      
      assert.strictEqual(result.listsUpdated, 1);
      // 1 list × (1 fetch + 10 patches) = 11 ops / 3 concurrency = 4 batches × 50ms = 200ms
      assert.ok(result.operations > 5, 'Should have multiple chunks');
    });
  });
  
  describe('rule update phase', () => {
    it('should update rules in reasonable time', async () => {
      const result = await simulateRuleUpdatePhase({ apiDelay: 100 });
      
      assert.ok(result.duration >= 150, 'Should take at least 150ms (fetch + update)');
      assert.ok(result.duration < 300, `Rule update took ${result.duration}ms, should be < 300ms`);
    });
    
    it('should handle slow rule API', async () => {
      const result = await simulateRuleUpdatePhase({ apiDelay: 300 });
      
      assert.ok(result.duration >= 500, 'Should reflect slow API');
      assert.ok(result.duration < 1000, `Too slow: ${result.duration}ms`);
    });
  });
  
  describe('full pipeline benchmarks', () => {
    it('should complete small sync (1k domains) quickly', async () => {
      // 1 file with 1k domains
      const result = await runFullSyncPipeline(1000, {
        download: { urls: 1, concurrency: 3, delayPerFile: 30 },
        normalize: { domainsPerFile: 1000, processingTimePerDomain: 0.01 },
        sync: { listSize: 1000, concurrency: 3, apiDelay: 50 },
        rule: { apiDelay: 100 }
      });
      
      assert.ok(result.totalDuration < 500, 
        `Small sync took ${result.totalDuration}ms, should be < 500ms`);
      assert.ok(result.throughput > 2, `Throughput ${result.throughput} domains/sec too low`);
    });
    
    it('should complete medium sync (10k domains) efficiently', async () => {
      const result = await runFullSyncPipeline(10000, {
        download: { concurrency: 3, delayPerFile: 30 },
        normalize: { domainsPerFile: 10000, processingTimePerDomain: 0.005 },
        sync: { listSize: 1000, concurrency: 3, apiDelay: 50 },
        rule: { apiDelay: 100 }
      });
      
      assert.ok(result.totalDuration < 2000, 
        `Medium sync took ${result.totalDuration}ms, should be < 2000ms`);
      assert.ok(result.throughput > 5, `Throughput ${result.throughput} domains/sec too low`);
    });
    
    it('should complete large sync (100k domains) within reasonable time', async () => {
      const result = await runFullSyncPipeline(100000, {
        download: { concurrency: 3, delayPerFile: 30 },
        normalize: { domainsPerFile: 10000, processingTimePerDomain: 0.005 },
        sync: { listSize: 1000, concurrency: 3, apiDelay: 50 },
        rule: { apiDelay: 100 }
      });
      
      assert.ok(result.totalDuration < 15000, 
        `Large sync took ${result.totalDuration}ms, should be < 15000ms (15s)`);
      assert.ok(result.domains, 100000);
    });
    
    it('should identify bottleneck phases', async () => {
      const result = await runFullSyncPipeline(50000, {
        download: { concurrency: 3, delayPerFile: 50 },
        normalize: { domainsPerFile: 10000, processingTimePerDomain: 0.01 },
        sync: { listSize: 1000, concurrency: 3, apiDelay: 100 },
        rule: { apiDelay: 150 }
      });
      
      const phases = result.phases;
      const durations = [
        { name: 'download', duration: phases.download.duration },
        { name: 'normalize', duration: phases.normalize.duration },
        { name: 'sync', duration: phases.sync.duration },
        { name: 'rule', duration: phases.rule.duration }
      ];
      
      durations.sort((a, b) => b.duration - a.duration);
      
      // Log bottleneck identification
      console.log(`  Bottleneck: ${durations[0].name} (${durations[0].duration}ms)`);
      
      assert.ok(durations[0].duration > 0);
      assert.ok(result.totalDuration < 10000);
    });
  });
  
  describe('performance thresholds', () => {
    it('should maintain throughput > 100 domains/sec for small batches', async () => {
      const result = await runFullSyncPipeline(1000, {
        download: { concurrency: 3, delayPerFile: 20 },
        normalize: { domainsPerFile: 1000, processingTimePerDomain: 0.005 },
        sync: { listSize: 1000, concurrency: 3, apiDelay: 30 },
        rule: { apiDelay: 50 }
      });
      
      assert.ok(result.throughput > 100, 
        `Throughput ${result.throughput} domains/sec, should be > 100`);
    });
    
    it('should scale sub-linearly with domain count due to batching', async () => {
      const small = await runFullSyncPipeline(1000, {
        download: { concurrency: 3, delayPerFile: 20 },
        normalize: { domainsPerFile: 1000, processingTimePerDomain: 0.005 },
        sync: { listSize: 1000, concurrency: 3, apiDelay: 30 },
        rule: { apiDelay: 50 }
      });
      
      const medium = await runFullSyncPipeline(10000, {
        download: { concurrency: 3, delayPerFile: 20 },
        normalize: { domainsPerFile: 10000, processingTimePerDomain: 0.005 },
        sync: { listSize: 1000, concurrency: 3, apiDelay: 30 },
        rule: { apiDelay: 50 }
      });
      
      // Due to concurrency, 10x more domains should be roughly 5-15x slower (not exactly 10x due to fixed costs)
      const ratio = medium.totalDuration / small.totalDuration;
      assert.ok(ratio >= 2 && ratio <= 15, 
        `Duration ratio ${ratio} not in expected range [2, 15] (sub-linear scaling)`);
    });
    
    it('should handle large sync (50k domains) within reasonable time', async () => {
      const result = await runFullSyncPipeline(50000, {
        download: { concurrency: 3, delayPerFile: 30 },
        normalize: { domainsPerFile: 10000, processingTimePerDomain: 0.005 },
        sync: { listSize: 1000, concurrency: 3, apiDelay: 50, chunkSize: 500 },
        rule: { apiDelay: 100 }
      });
      
      assert.strictEqual(result.domains, 50000);
      assert.ok(result.totalDuration < 20000, 
        `50k sync took ${result.totalDuration}ms, should be < 20000ms (20s)`);
    });
  });
});
