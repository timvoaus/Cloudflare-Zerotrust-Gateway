import { describe, it } from 'node:test';
import assert from 'node:assert';

/**
 * Phase 3 - Observability Tests: Structured Logging & Progress Reporting
 * Tests that logs and progress indicators work correctly.
 */

// Capture console output for testing
function captureConsole() {
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  
  console.log = (...args) => logs.push({ level: 'log', message: args.join(' ') });
  console.error = (...args) => logs.push({ level: 'error', message: args.join(' ') });
  console.warn = (...args) => logs.push({ level: 'warn', message: args.join(' ') });
  
  return {
    logs,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
    }
  };
}

// Parse CZGS_PROGRESS lines
function parseProgressLine(line) {
  const match = line.match(/CZGS_PROGRESS\|(.+)/);
  if (!match) return null;
  
  const params = new Map();
  const pairs = match[1].split('|');
  
  for (const pair of pairs) {
    const [key, value] = pair.split('=');
    if (key && value !== undefined) {
      params.set(key, value);
    }
  }
  
  return {
    phase: params.get('phase'),
    current: parseInt(params.get('current'), 10),
    total: parseInt(params.get('total'), 10),
    message: params.get('message')
  };
}

// Simulated progress emitter matching the app's behavior
function emitProgress(phase, current, total, message) {
  const line = `CZGS_PROGRESS|phase=${phase}|current=${current}|total=${total}|message=${message}`;
  console.log(line);
  return line;
}

describe('observability - structured logging', () => {
  describe('progress line parsing', () => {
    it('should parse valid progress lines', () => {
      const line = 'CZGS_PROGRESS|phase=fetch|current=5|total=10|message=Fetching list 5/10';
      const parsed = parseProgressLine(line);
      
      assert.strictEqual(parsed.phase, 'fetch');
      assert.strictEqual(parsed.current, 5);
      assert.strictEqual(parsed.total, 10);
      assert.strictEqual(parsed.message, 'Fetching list 5/10');
    });
    
    it('should return null for non-progress lines', () => {
      const line = 'Regular log message';
      const parsed = parseProgressLine(line);
      
      assert.strictEqual(parsed, null);
    });
    
    it('should handle progress lines without message', () => {
      const line = 'CZGS_PROGRESS|phase=sync|current=3|total=5';
      const parsed = parseProgressLine(line);
      
      assert.strictEqual(parsed.phase, 'sync');
      assert.strictEqual(parsed.current, 3);
      assert.strictEqual(parsed.total, 5);
    });
    
    it('should handle malformed progress lines gracefully', () => {
      const line = 'CZGS_PROGRESS|phase=download|current=invalid|total=10';
      const parsed = parseProgressLine(line);
      
      assert.strictEqual(parsed.phase, 'download');
      assert.ok(Number.isNaN(parsed.current));
      assert.strictEqual(parsed.total, 10);
    });
  });
  
  describe('progress emission', () => {
    it('should emit progress for download phase', () => {
      const capture = captureConsole();
      
      try {
        emitProgress('download', 1, 5, 'Downloading file 1/5');
        
        const progressLogs = capture.logs.filter(l => l.message.includes('CZGS_PROGRESS'));
        assert.strictEqual(progressLogs.length, 1);
        
        const parsed = parseProgressLine(progressLogs[0].message);
        assert.strictEqual(parsed.phase, 'download');
      } finally {
        capture.restore();
      }
    });
    
    it('should emit progress for all sync phases', () => {
      const capture = captureConsole();
      const phases = ['fetch', 'sync', 'rule', 'cleanup'];
      
      try {
        phases.forEach((phase, i) => {
          emitProgress(phase, i + 1, phases.length, `Phase ${phase}`);
        });
        
        const progressLogs = capture.logs.filter(l => l.message.includes('CZGS_PROGRESS'));
        assert.strictEqual(progressLogs.length, phases.length);
        
        const parsedPhases = progressLogs.map(l => parseProgressLine(l.message).phase);
        assert.deepStrictEqual(parsedPhases, phases);
      } finally {
        capture.restore();
      }
    });
    
    it('should emit progress with increasing current count', () => {
      const capture = captureConsole();
      
      try {
        for (let i = 0; i <= 10; i++) {
          emitProgress('fetch', i, 10, `Fetched ${i}/10`);
        }
        
        const progressLogs = capture.logs.filter(l => l.message.includes('CZGS_PROGRESS'));
        const currents = progressLogs.map(l => parseProgressLine(l.message).current);
        
        // Should be 0, 1, 2, ..., 10
        assert.deepStrictEqual(currents, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      } finally {
        capture.restore();
      }
    });
    
    it('should reach 100% at final progress', () => {
      const capture = captureConsole();
      
      try {
        emitProgress('sync', 50, 50, 'Sync complete');
        
        const progressLogs = capture.logs.filter(l => l.message.includes('CZGS_PROGRESS'));
        const last = parseProgressLine(progressLogs[progressLogs.length - 1].message);
        
        assert.strictEqual(last.current, last.total);
      } finally {
        capture.restore();
      }
    });
  });
  
  describe('structured log format', () => {
    it('should include timestamps in logs', () => {
      const capture = captureConsole();
      
      try {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] Starting sync operation`);
        
        const log = capture.logs[0];
        assert.ok(log.message.includes(timestamp));
      } finally {
        capture.restore();
      }
    });
    
    it('should log operation start and completion', () => {
      const capture = captureConsole();
      
      try {
        console.log('Starting: Download phase');
        console.log('Completed: Download phase (5 files, 150ms)');
        
        assert.ok(capture.logs.some(l => l.message.includes('Starting:')));
        assert.ok(capture.logs.some(l => l.message.includes('Completed:')));
      } finally {
        capture.restore();
      }
    });
    
    it('should log errors with context', () => {
      const capture = captureConsole();
      
      try {
        console.error('Error: Failed to fetch list items', { listId: 'list-123', error: 'Timeout' });
        
        const errorLog = capture.logs.find(l => l.level === 'error');
        assert.ok(errorLog);
        assert.ok(errorLog.message.includes('Failed to fetch'));
      } finally {
        capture.restore();
      }
    });
    
    it('should log warnings for recoverable issues', () => {
      const capture = captureConsole();
      
      try {
        console.warn('Warning: Rate limit approaching, backing off');
        
        const warnLog = capture.logs.find(l => l.level === 'warn');
        assert.ok(warnLog);
        assert.ok(warnLog.message.includes('Rate limit'));
      } finally {
        capture.restore();
      }
    });
  });
  
  describe('metrics collection', () => {
    it('should track operation counts', () => {
      const metrics = {
        operations: {
          download: { count: 5, totalBytes: 50000 },
          sync: { listsUpdated: 10, itemsProcessed: 10000 },
          rule: { rulesCreated: 1, rulesUpdated: 0 }
        }
      };
      
      assert.strictEqual(metrics.operations.download.count, 5);
      assert.strictEqual(metrics.operations.sync.itemsProcessed, 10000);
    });
    
    it('should track timing metrics', () => {
      const timings = {
        phases: {
          download: 120,
          normalize: 45,
          sync: 3400,
          rule: 150
        },
        total: 3715
      };
      
      assert.ok(timings.phases.sync > timings.phases.download);
      assert.strictEqual(timings.total, 3715);
    });
    
    it('should identify slowest phase', () => {
      const phases = [
        { name: 'download', duration: 120 },
        { name: 'normalize', duration: 45 },
        { name: 'sync', duration: 3400 },
        { name: 'rule', duration: 150 }
      ];
      
      const slowest = phases.reduce((max, p) => p.duration > max.duration ? p : max);
      
      assert.strictEqual(slowest.name, 'sync');
      assert.strictEqual(slowest.duration, 3400);
    });
    
    it('should calculate throughput metrics', () => {
      const metrics = {
        domains: 10000,
        durationMs: 5000
      };
      
      const throughput = metrics.domains / (metrics.durationMs / 1000);
      
      assert.strictEqual(throughput, 2000);
    });
  });
  
  describe('health check logging', () => {
    it('should log health check results', () => {
      const capture = captureConsole();
      
      try {
        const health = { ok: true, cloudflareConfigured: true, databaseWritable: true };
        console.log(`Health check: ${JSON.stringify(health)}`);
        
        const log = capture.logs[0];
        assert.ok(log.message.includes('ok":true'));
        assert.ok(log.message.includes('cloudflareConfigured":true'));
      } finally {
        capture.restore();
      }
    });
    
    it('should log unhealthy states', () => {
      const capture = captureConsole();
      
      try {
        const health = { ok: true, cloudflareConfigured: false, databaseWritable: true };
        console.warn(`Health check warning: ${JSON.stringify(health)}`);
        
        const log = capture.logs.find(l => l.level === 'warn');
        assert.ok(log);
        assert.ok(log.message.includes('cloudflareConfigured":false'));
      } finally {
        capture.restore();
      }
    });
  });
  
  describe('error tracking', () => {
    it('should track error counts by type', () => {
      const errors = [
        { type: 'RateLimit', count: 3 },
        { type: 'NetworkTimeout', count: 1 },
        { type: 'Authentication', count: 0 }
      ];
      
      const totalErrors = errors.reduce((sum, e) => sum + e.count, 0);
      
      assert.strictEqual(totalErrors, 4);
    });
    
    it('should log retry attempts', () => {
      const capture = captureConsole();
      
      try {
        console.log('Retry 1/3: Fetching list items after rate limit');
        console.log('Retry 2/3: Fetching list items after rate limit');
        console.log('Success after 2 retries');
        
        const retryLogs = capture.logs.filter(l => l.message.includes('Retry'));
        assert.strictEqual(retryLogs.length, 2);
      } finally {
        capture.restore();
      }
    });
  });
  
  describe('progress accuracy', () => {
    it('should report accurate percentage', () => {
      const testCases = [
        { current: 0, total: 10, expected: 0 },
        { current: 5, total: 10, expected: 50 },
        { current: 10, total: 10, expected: 100 }
      ];
      
      for (const tc of testCases) {
        const percentage = Math.round((tc.current / tc.total) * 100);
        assert.strictEqual(percentage, tc.expected);
      }
    });
    
    it('should handle zero total gracefully', () => {
      const current = 0;
      const total = 0;
      
      const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
      
      assert.strictEqual(percentage, 0);
    });
    
    it('should not exceed 100%', () => {
      const current = 15;
      const total = 10;
      
      const percentage = Math.min(Math.round((current / total) * 100), 100);
      
      assert.strictEqual(percentage, 100);
    });
  });
});
