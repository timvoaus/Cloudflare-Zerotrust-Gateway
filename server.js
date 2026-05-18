import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from "node:child_process";

// Regex to parse CZGS_PROGRESS lines from child process output
const PROGRESS_REGEX = /^CZGS_PROGRESS\|(.+)$/;
import { initDNSAnalytics, syncDNSAnalyticsToDatabase, buildDNSAnalyticsDataFromCache, fetchDNSTimeSeriesData, fetchTopDomains, fetchTopLocations, fetchResolverDecisions } from './lib/server/dns-analytics.js';
import { initTrafficMap, syncTrafficMapAggregatesToDatabase, isTrafficMapGraphQLSyncFresh, buildTrafficMapData, emitTrafficMapData, TRAFFIC_MAP_HOURS, TRAFFIC_MAP_ACTIVITY_LIMIT, TRAFFIC_MAP_MAX_ACTIVITY_PAGES, TRAFFIC_MAP_ACTIVITY_FIELDS, TRAFFIC_MAP_COUNTRY_CENTROIDS } from './lib/server/traffic-map.js';
import {
  DASHBOARD_USERNAME,
  DASHBOARD_PASSWORD,
  DASHBOARD_AUTH_DISABLED,
  DASHBOARD_ALLOWED_ORIGINS,
  isDashboardRequestAuthorized,
  requireDashboardAccess,
  createSocketAuthOptions,
  logDashboardSecurityWarning,
} from './lib/server/dashboard-auth.js';
import {
  CUSTOM_ALLOWLIST_NAME,
  CUSTOM_ALLOW_RULE_NAME,
  CUSTOM_DENYLIST_NAME,
  CUSTOM_DENY_RULE_NAME,
  GENERATED_LIST_NAME_PREFIX,
  GENERATED_RULE_NAME_PREFIX,
  RULE_ORDER_WARNING,
  isGeneratedListName,
  isGeneratedRuleName,
  isCustomAllowlistName,
  isCustomDenylistName,
  isCustomAllowRuleName,
  isCustomDenyRuleName,
  findCustomAllowlist,
  findCustomDenylist,
  upsertAllowRule,
  upsertDenyRule,
  findOrCreateAllowlist,
  findOrCreateDenylist,
} from './lib/server/custom-gateway.js';
import {
  DNS_REWRITE_RULE_PREFIX,
  DNS_REWRITE_RULE_DESCRIPTION,
  isDnsRewriteRuleName,
  normalizeRewriteDomain,
  escapeWirefilterString,
  isValidRewriteDomain,
  parseRewriteLines,
  getRewriteDomainFromRule,
  getRewriteIpsFromRule,
  upsertDnsRewriteRule,
  serializeDnsRewriteRule,
} from './lib/server/dns-rewrite.js';
import {
  GATEWAY_LOCATION_ID,
  detectGatewayLocationId,
  getPrimaryIpv4Network,
  getDnsEndpointValue,
  pickEndpointFields,
  buildGatewayLocationUpdatePayload,
  serializeGatewayLocationIpv4,
} from './lib/server/gateway-location.js';
import { isIP } from 'node:net';
import { fileURLToPath } from 'url';
import geoip from 'geoip-lite';
import { DatabaseSync } from 'node:sqlite';
import { getEnvPath } from './lib/env.js';
import { loadManifest } from './lib/sync-manifest.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ENV_PATH = getEnvPath();

// Import constants for DNS analytics and dynamic Cloudflare Gateway API requests.
import {
  getZeroTrustLists,
  getZeroTrustRules,
  deleteZeroTrustListsOneByOne,
  deleteZeroTrustRule,
  getZeroTrustListItemValues,
  patchExistingListChunked,
  defragmentZeroTrustLists,
  upsertZeroTrustDNSRule,
  upsertZeroTrustSNIRule,
} from './lib/api.js';
import { requestGateway } from './lib/helpers.js';
import { 
  ACCOUNT_ID,
  API_TOKEN,
  RECOMMENDED_ALLOWLIST_URLS, 
  RECOMMENDED_BLOCKLIST_URLS,
  GATEWAY_PATCH_CHUNK_SIZE,
  BLOCK_BASED_ON_SNI,
  CZGS_AUTO_DEFRAGMENT,
} from './lib/constants.js';

const DATA_DIR = join(__dirname, 'data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR);

const db = new DatabaseSync(join(DATA_DIR, 'traffic_logs.db'));

// Cache for auto-detected Gateway Location ID
let detectedGatewayLocationId = null;

/**
 * Get the Gateway Location ID (from env or auto-detect).
 * @param {Socket|null} socket - Optional socket for logging
 * @returns {Promise<string|null>} - Location ID or null
 */
async function getGatewayLocationId(socket = null) {
  // Use explicitly set env var if available
  if (GATEWAY_LOCATION_ID) {
    return GATEWAY_LOCATION_ID;
  }

  // Return cached detected ID if available
  if (detectedGatewayLocationId) {
    return detectedGatewayLocationId;
  }

  // Auto-detect from API
  if (socket) {
    socket.emit('log', '\x1b[36mAuto-detecting Gateway Location ID...\x1b[0m\n');
  }

  const detected = await detectGatewayLocationId(ACCOUNT_ID, API_TOKEN);

  if (detected) {
    detectedGatewayLocationId = detected;
    if (socket) {
      socket.emit('log', `\x1b[32mAuto-detected Gateway Location: ${detected}\x1b[0m\n`);
    }
    return detected;
  }

  if (socket) {
    socket.emit('log', '\x1b[31mFailed to auto-detect Gateway Location ID.\x1b[0m\n');
    socket.emit('log', '\x1b[33mSet CLOUDFLARE_GATEWAY_LOCATION_ID in your .env file.\x1b[0m\n');
  }
  return null;
}

// Initialize modules with database and credentials
initDNSAnalytics({ database: db, accountId: ACCOUNT_ID, apiToken: API_TOKEN });
initTrafficMap({ database: db, accountId: ACCOUNT_ID, apiToken: API_TOKEN });

db.exec(`
  CREATE TABLE IF NOT EXISTS logs (
    query_id TEXT PRIMARY KEY,
    datetime TEXT,
    src_country TEXT,
    src_country_code TEXT,
    source_ip TEXT,
    resolved_ips TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_datetime ON logs(datetime);

  -- DNS Analytics cache tables (15-minute buckets)
  CREATE TABLE IF NOT EXISTS dns_timeseries (
    bucket_ts INTEGER PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_dns_ts_bucket ON dns_timeseries(bucket_ts);

  CREATE TABLE IF NOT EXISTS dns_top_domains (
    bucket_ts INTEGER NOT NULL,
    domain TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket_ts, domain)
  );
  CREATE INDEX IF NOT EXISTS idx_dns_domains_bucket ON dns_top_domains(bucket_ts);

  CREATE TABLE IF NOT EXISTS dns_top_locations (
    bucket_ts INTEGER NOT NULL,
    location TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket_ts, location)
  );
  CREATE INDEX IF NOT EXISTS idx_dns_locations_bucket ON dns_top_locations(bucket_ts);

  CREATE TABLE IF NOT EXISTS dns_resolver_decisions (
    bucket_ts INTEGER NOT NULL,
    decision TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket_ts, decision)
  );
  CREATE INDEX IF NOT EXISTS idx_dns_decisions_bucket ON dns_resolver_decisions(bucket_ts);

  -- Sync state tracking for incremental updates
  CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    last_synced_ts INTEGER,
    oldest_synced_ts INTEGER
  );

  CREATE TABLE IF NOT EXISTS traffic_map_sources (
    country TEXT PRIMARY KEY,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS traffic_map_destinations (
    country TEXT PRIMARY KEY,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS traffic_map_routes (
    source_country TEXT NOT NULL,
    destination_country TEXT NOT NULL,
    source_lat REAL NOT NULL,
    source_lng REAL NOT NULL,
    destination_lat REAL NOT NULL,
    destination_lng REAL NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (source_country, destination_country)
  );

  CREATE TABLE IF NOT EXISTS traffic_map_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS traffic_map_daily_snapshots (
    day TEXT PRIMARY KEY,
    total_queries INTEGER NOT NULL,
    source_count INTEGER NOT NULL,
    destination_count INTEGER NOT NULL,
    route_count INTEGER NOT NULL,
    payload TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_traffic_map_daily_snapshots_day ON traffic_map_daily_snapshots(day);
`);

const app = express();
const httpServer = createServer(app);

// Dashboard auth options from module
const socketOptions = createSocketAuthOptions(DASHBOARD_ALLOWED_ORIGINS);

const io = new Server(httpServer, socketOptions);
const socketViewState = new Map();

// Health check endpoint - must be before auth middleware
// Get version from package.json
let appVersion = 'unknown';
try {
  const packageJson = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
  appVersion = packageJson.version || 'unknown';
} catch {
  // Version stays as 'unknown' if file can't be read
}

const startTime = Date.now();

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

function getLastSyncInfo() {
  const manifest = loadManifest();
  const listSyncAt = manifest?.generatedAt ?? null;

  let trafficMapAt = null;
  try {
    const row = db.prepare(
      "SELECT last_synced_ts FROM sync_state WHERE key = 'traffic_map_graphql'"
    ).get();
    if (row?.last_synced_ts) {
      trafficMapAt = new Date(row.last_synced_ts * 1000).toISOString();
    }
  } catch {
    // sync_state may not exist yet
  }

  return { listSyncAt, trafficMapAt };
}

app.get('/api/health', (req, res) => {
  // Check database writability
  let databaseWritable = false;
  try {
    // Try a simple write operation to verify DB is accessible
    db.exec('CREATE TABLE IF NOT EXISTS _health_check (id INTEGER PRIMARY KEY)');
    databaseWritable = true;
  } catch {
    databaseWritable = false;
  }

  const health = {
    ok: true,
    cloudflareConfigured: !!(API_TOKEN && ACCOUNT_ID),
    databaseWritable,
    dataDir: DATA_DIR,
    lastSync: getLastSyncInfo(),
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version: appVersion,
  };

  res.status(200).json(health);
});

app.use(requireDashboardAccess);
app.use(express.static(join(__dirname, 'public')));
app.use('/vendor/chart.js', express.static(join(__dirname, 'node_modules', 'chart.js', 'dist')));
app.use('/vendor/d3', express.static(join(__dirname, 'node_modules', 'd3', 'dist')));
app.use('/vendor/topojson-client', express.static(join(__dirname, 'node_modules', 'topojson-client', 'dist')));
app.use('/vendor/world-atlas', express.static(join(__dirname, 'node_modules', 'world-atlas')));
app.use(express.json());

// Settings endpoint removed. Configure via .env or environment variables.


// Helper to spawn and stream output
function runScript(scriptArgs, socket) {
  return new Promise((resolvePromise, rejectPromise) => {
    socket.emit('log', `\x1b[36m> node ${scriptArgs.join(' ')}\x1b[0m\n`);
    
    // Strip list URL keys so they are re-read fresh
    const { BLOCKLIST_URLS, ALLOWLIST_URLS, ...inheritedEnv } = process.env;
    const child = spawn("node", scriptArgs, {
      cwd: __dirname,
      env: { ...inheritedEnv },
    });

    child.stdout.on("data", (data) => {
      const lines = data.toString().split("\n");
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        // Check for progress line
        const progressMatch = trimmed.match(PROGRESS_REGEX);
        if (progressMatch) {
          try {
            // Parse key=value pairs (handle | as separator)
            const params = new Map();
            const pairs = progressMatch[1].split("|");
            for (const pair of pairs) {
              const [key, value] = pair.split("=");
              if (key && value !== undefined) {
                params.set(key, value);
              }
            }
            
            const phase = params.get("phase");
            const current = parseInt(params.get("current"), 10);
            const total = parseInt(params.get("total"), 10);
            const message = params.get("message");
            
            if (phase && !isNaN(current) && !isNaN(total)) {
              // Emit structured progress event to frontend
              socket.emit("script_progress", {
                phase,
                current,
                total,
                message: message || `${phase} ${current}/${total}`,
                timestamp: Date.now(),
              });
            }
          } catch (err) {
            // Ignore parse errors, fall through to regular log
          }
        }
        
        // Always emit to terminal (preserve existing behavior)
        socket.emit("log", line + "\n");
      }
    });
    
    child.stderr.on("data", (data) => socket.emit("log", `\x1b[31m${data.toString()}\x1b[0m`));

    child.on("error", (err) => {
      socket.emit("log", `\x1b[31mFailed to start process: ${err.message}\x1b[0m\n`);
      rejectPromise(err);
    });

    child.on("close", (code) => {
      if (code === 0) {
        socket.emit("log", `\x1b[32m✔ Script finished successfully.\x1b[0m\n\n`);
        resolvePromise();
      } else {
        socket.emit("log", `\x1b[31m✖ Script exited with code ${code}\x1b[0m\n\n`);
        rejectPromise(new Error(`Script exited with code ${code}`));
      }
    });
  });
}

// Environment File Helpers
function readEnvUrls(key) {
  if (!existsSync(ENV_PATH)) {
    return process.env[key]
      ? process.env[key].split("\n").map(u => u.trim()).filter(Boolean)
      : [];
  }
  const content = readFileSync(ENV_PATH, "utf8");
  
  const quotedMatch = content.match(new RegExp(`^(?:#\\s*)?${key}="([\\s\\S]*?)"`, "m"));
  if (quotedMatch) return quotedMatch[1].split("\n").map(u => u.trim()).filter(Boolean);
  
  const singleMatch = content.match(new RegExp(`^(?:#\\s*)?${key}=(.+)$`, "m"));
  if (singleMatch) return singleMatch[1].trim().split(/\\n/).map(u => u.trim()).filter(Boolean);
  
  return [];
}

function writeEnvUrls(key, urls) {
  if (!existsSync(ENV_PATH)) {
    mkdirSync(dirname(ENV_PATH), { recursive: true });

    const existingBlocklistUrls = process.env.BLOCKLIST_URLS ? `BLOCKLIST_URLS="${process.env.BLOCKLIST_URLS}"\n` : "";
    const existingAllowlistUrls = process.env.ALLOWLIST_URLS ? `ALLOWLIST_URLS="${process.env.ALLOWLIST_URLS}"\n` : "";
    writeFileSync(ENV_PATH, `${existingBlocklistUrls}${existingAllowlistUrls}`, "utf8");
  }
  
  let content = readFileSync(ENV_PATH, "utf8");
  const value = `"${urls.join("\n")}"`;
  const newLine = `${key}=${value}`;
  
  const quotedPattern = new RegExp(`^(?:#\\s*)?${key}="[\\s\\S]*?"`, "m");
  const singlePattern = new RegExp(`^(?:#\\s*)?${key}=.*$`, "m");
  
  if (quotedPattern.test(content)) content = content.replace(quotedPattern, newLine);
  else if (singlePattern.test(content)) content = content.replace(singlePattern, newLine);
  else content = `${content}\n${newLine}`;
  
  writeFileSync(ENV_PATH, content, "utf8");
}

// Allowlist Helpers
const CUSTOM_LIST_DOMAIN_RE = /^([a-z0-9-]+\.)+[a-z]{2,}$/;

async function fetchCustomListItems(listId) {
  return getZeroTrustListItemValues(listId);
}

async function prepareCustomListDomains({ action, listId, domains, socket }) {
  const validDomains = [];
  const invalidDomains = [];
  const duplicateDomains = [];
  const seenDomains = new Set();

  for (const value of domains ?? []) {
    const domain = String(value || "").trim().toLowerCase();

    if (!CUSTOM_LIST_DOMAIN_RE.test(domain)) {
      invalidDomains.push(value);
      continue;
    }

    if (seenDomains.has(domain)) {
      duplicateDomains.push(domain);
      continue;
    }

    seenDomains.add(domain);
    validDomains.push(domain);
  }

  if (invalidDomains.length > 0) {
    socket.emit('log', `\x1b[33mSkipping ${invalidDomains.length} invalid domain(s): ${invalidDomains.join(', ')}\x1b[0m\n`);
  }

  if (duplicateDomains.length > 0) {
    socket.emit('log', `\x1b[33mSkipping ${duplicateDomains.length} duplicate input domain(s): ${duplicateDomains.join(', ')}\x1b[0m\n`);
  }

  if (validDomains.length === 0) {
    socket.emit('log', `\x1b[31mNo valid domains to process.\x1b[0m\n`);
    return [];
  }

  socket.emit('log', `\x1b[34mChecking domains in list...\x1b[0m\n`);
  const existingItems = await fetchCustomListItems(listId);
  const existingSet = new Set(existingItems);

  if (action === 'add') {
    const existingDomains = validDomains.filter(domain => existingSet.has(domain));
    const domainsToAdd = validDomains.filter(domain => !existingSet.has(domain));

    if (existingDomains.length > 0) {
      socket.emit('log', `\x1b[33mSkipping ${existingDomains.length} domain(s) already in list: ${existingDomains.join(', ')}\x1b[0m\n`);
    }

    if (domainsToAdd.length === 0) {
      socket.emit('log', `\x1b[33mAll valid domains are already in the list. Skipping add.\x1b[0m\n`);
    }

    return domainsToAdd;
  }

  if (action === 'remove') {
    const domainsToRemove = validDomains.filter(domain => existingSet.has(domain));
    const notFoundDomains = validDomains.filter(domain => !existingSet.has(domain));

    if (notFoundDomains.length > 0) {
      socket.emit('log', `\x1b[33mSkipping ${notFoundDomains.length} domain(s) not found in list: ${notFoundDomains.join(', ')}\x1b[0m\n`);
    }

    if (domainsToRemove.length === 0) {
      socket.emit('log', `\x1b[33mNone of the valid domains were found in the list. Skipping remove.\x1b[0m\n`);
    }

    return domainsToRemove;
  }

  throw new Error(`Unsupported list action: ${action}`);
}


// Traffic Map module imported from lib/server/traffic-map.js

function countryPoint(country, geo = null) {
  if (geo?.ll?.length === 2) {
    return {
      lat: geo.ll[0],
      lng: geo.ll[1],
      city: geo.city || '',
      region: geo.region || '',
    };
  }

  const centroid = TRAFFIC_MAP_COUNTRY_CENTROIDS[country];
  return centroid ? { lat: centroid[0], lng: centroid[1], city: '', region: '' } : { lat: null, lng: null, city: '', region: '' };
}

function serializeTopEntries(counts, keyName, limit = 8) {
  return Array.from(counts.entries())
    .map(([value, count]) => ({ [keyName]: value, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

async function fetchGatewayActivityPage(paramsBase, page) {
  const params = new URLSearchParams({ ...paramsBase, page: String(page) });
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/gateway-analytics/activities?${params.toString()}`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  const data = await response.json();

  if (!response.ok || data.success === false) {
    throw new Error(`Gateway activities error: ${JSON.stringify(data.errors || data)}`);
  }
  return Array.isArray(data.result?.logs) ? data.result.logs : [];
}

let isSyncing = false;
async function syncTrafficLogsToDatabase(forceFull = false) {
  if (isSyncing) return;
  isSyncing = true;
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    let fromSec = nowSec - TRAFFIC_MAP_HOURS * 60 * 60;
    
    if (!forceFull) {
      const stmt = db.prepare('SELECT MAX(datetime) as latest FROM logs');
      const row = stmt.get();
      if (row && row.latest) {
        const latestSec = row.latest;
        if (latestSec > fromSec) {
          fromSec = latestSec;
        }
      }
    }

    const paramsBase = {
      from: String(fromSec),
      to: String(nowSec),
      limit: String(TRAFFIC_MAP_ACTIVITY_LIMIT),
      fields: TRAFFIC_MAP_ACTIVITY_FIELDS.join(','),
    };

    let fetchedLogs = [];
    console.log(`Starting background sync... fetching from ${new Date(fromSec * 1000).toLocaleString()}`);
    
    // Process pages in batches of 3 to avoid hanging the Cloudflare API
    for (let batch = 0; batch < Math.ceil(TRAFFIC_MAP_MAX_ACTIVITY_PAGES / 3); batch++) {
      const promises = [];
      for (let i = 0; i < 3; i++) {
        const page = batch * 3 + i + 1;
        if (page > TRAFFIC_MAP_MAX_ACTIVITY_PAGES) break;
        promises.push(fetchGatewayActivityPage(paramsBase, page).catch(e => {
          console.error(`Page ${page} failed:`, e.message);
          return [];
        }));
      }
      const batchLogs = await Promise.all(promises);
      let batchTotal = 0;
      for (const pageLogs of batchLogs) {
        fetchedLogs.push(...pageLogs);
        batchTotal += pageLogs.length;
      }
      console.log(`Batch ${batch + 1} fetched ${batchTotal} logs`);
    }

    console.log(`Sync finished API fetch. Total logs: ${fetchedLogs.length}`);

    if (fetchedLogs.length > 0) {
      const validLogs = fetchedLogs.filter((log) => log.query_id);
      const BATCH_SIZE = 500;

      db.exec('BEGIN TRANSACTION');
      try {
        for (let i = 0; i < validLogs.length; i += BATCH_SIZE) {
          const batch = validLogs.slice(i, i + BATCH_SIZE);
          const placeholders = batch.map(() => '(?,?,?,?,?,?)').join(',');
          const values = batch.flatMap((log) => [
            log.query_id,
            log.datetime || null,
            log.src_country || null,
            log.src_country_code || null,
            log.source_ip || null,
            JSON.stringify(log.resolved_ips || []),
          ]);
          db.prepare(`
            INSERT OR IGNORE INTO logs (query_id, datetime, src_country, src_country_code, source_ip, resolved_ips)
            VALUES ${placeholders}
          `).run(...values);
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
    
    // Update sync state for traffic map
    const updateSync = db.prepare(`
      INSERT INTO sync_state (key, last_synced_ts, oldest_synced_ts) 
      VALUES ('traffic_map', ?, COALESCE((SELECT oldest_synced_ts FROM sync_state WHERE key='traffic_map'), ?))
      ON CONFLICT(key) DO UPDATE SET last_synced_ts = excluded.last_synced_ts
    `);
    updateSync.run(nowSec, fromSec);
    
    console.log(`Traffic map sync complete. Fetched: ${fetchedLogs.length}, DB total: ${db.prepare('SELECT COUNT(*) as cnt FROM logs').get().cnt}`);
  } catch (err) {
    console.error('Background sync failed:', err);
  } finally {
    isSyncing = false;
  }
}

// Unified background sync scheduler (15 minutes)
const SYNC_INTERVAL_MS = 15 * 60 * 1000;

async function runUnifiedSync(forceFull = false) {
  console.log(`[${new Date().toISOString()}] Starting unified background sync...`);
  await Promise.all([
    syncTrafficLogsToDatabase(forceFull),
    syncDNSAnalyticsToDatabase(forceFull)
  ]);
  console.log(`[${new Date().toISOString()}] Unified sync complete`);
  await broadcastActiveDashboardData('live');
}

setInterval(() => runUnifiedSync(), SYNC_INTERVAL_MS);
// Trigger initial sync in background
runUnifiedSync(true);

function getCutoffForRange(range) {
  const nowSec = Math.floor(Date.now() / 1000);
  switch (range) {
    case '7d': return nowSec - 7 * 24 * 60 * 60;
    case '30d': return nowSec - 30 * 24 * 60 * 60;
    case '24h':
    default: return nowSec - 24 * 60 * 60;
  }
}

function buildTrafficMapDataFromLogs(range = '24h') {
  const cutoffSec = getCutoffForRange(range);
  const stmt = db.prepare('SELECT * FROM logs WHERE datetime >= ?');
  const dbLogs = stmt.all(cutoffSec);
  
  const logs = dbLogs.map(row => ({
    ...row,
    resolved_ips: row.resolved_ips ? JSON.parse(row.resolved_ips) : []
  }));
  const sources = new Map();
  const destinations = new Map();
  const routes = new Map();

  for (const log of logs) {
    const sourceCountry = normalizeCountryCode(log.src_country_code || log.src_country);
    if (!sourceCountry) continue;

    const sourcePoint = countryPoint(sourceCountry);
    let source = sources.get(sourceCountry);
    if (!source) {
      source = {
        country: sourceCountry,
        ...sourcePoint,
        count: 0,
        domainCounts: new Map(),
      };
      sources.set(sourceCountry, source);
    }
    source.count++;

    const domain = String(log.query || 'N/A').replace(/\.$/, '');
    source.domainCounts.set(domain, (source.domainCounts.get(domain) || 0) + 1);

    for (const ip of getResolvedIpCandidates(log)) {
      const geo = geoip.lookup(ip);
      const destinationCountry = normalizeCountryCode(geo?.country);
      if (!destinationCountry) continue;

      const destinationPoint = countryPoint(destinationCountry, geo);
      let destination = destinations.get(destinationCountry);
      if (!destination) {
        destination = {
          country: destinationCountry,
          ...destinationPoint,
          count: 0,
          domainCounts: new Map(),
        };
        destinations.set(destinationCountry, destination);
      }
      destination.count++;
      destination.domainCounts.set(domain, (destination.domainCounts.get(domain) || 0) + 1);

      if (source.lat == null || source.lng == null || destination.lat == null || destination.lng == null) continue;
      const routeKey = `${sourceCountry}->${destinationCountry}`;
      let route = routes.get(routeKey);
      if (!route) {
        route = {
          sourceCountry,
          sourceLat: source.lat,
          sourceLng: source.lng,
          destinationCountry,
          destinationLat: destination.lat,
          destinationLng: destination.lng,
          count: 0,
          domainCounts: new Map(),
        };
        routes.set(routeKey, route);
      }
      route.count++;
      route.domainCounts.set(domain, (route.domainCounts.get(domain) || 0) + 1);
      break;
    }
  }

  return {
    sources: Array.from(sources.values())
      .map(source => ({ ...source, domains: serializeTopEntries(source.domainCounts, 'domain') }))
      .sort((a, b) => b.count - a.count),
    destinations: Array.from(destinations.values())
      .map(destination => ({ ...destination, domains: serializeTopEntries(destination.domainCounts, 'domain') }))
      .sort((a, b) => b.count - a.count),
    routes: Array.from(routes.values())
      .map(route => ({ ...route, domains: serializeTopEntries(route.domainCounts, 'domain', 5) }))
      .sort((a, b) => b.count - a.count),
    logsCount: logs.length,
    updatedAt: Date.now(),
  };
}

function emitDNSAnalyticsData(socket, range = '24h', source = 'cache') {
  const cached = buildDNSAnalyticsDataFromCache(range);
  if (cached) {
    socket.emit('dns_analytics_data', {
      success: true,
      ...cached,
      range,
      source,
      cachedAt: source === 'live' ? new Date().toISOString() : cached.cachedAt,
    });
  } else {
    socket.emit('dns_analytics_data', {
      success: true,
      timeSeries: [],
      totalCount: 0,
      topDomains: [],
      topLocations: [],
      resolverDecisions: [],
      range,
      source: 'cache',
      cachedAt: null,
    });
  }
}

async function broadcastActiveDashboardData(source = 'live') {
  const tasks = [];
  for (const socket of io.sockets.sockets.values()) {
    const state = socketViewState.get(socket.id);
    if (state?.activeTab === 'dns-analytics') {
      emitDNSAnalyticsData(socket, state.dnsRange || '24h', source);
    } else if (state?.activeTab === 'traffic-map') {
      tasks.push(emitTrafficMapData(socket, state.trafficRange || '24h', source));
    }
  }
  await Promise.allSettled(tasks);
}

// Socket Communication
io.on('connection', (socket) => {
  socketViewState.set(socket.id, { activeTab: 'dns-analytics', dnsRange: '24h', trafficRange: '24h' });

  socket.on('dashboard_view_state', (state = {}) => {
    const current = socketViewState.get(socket.id) || {};
    socketViewState.set(socket.id, {
      ...current,
      activeTab: state.activeTab || current.activeTab || 'dns-analytics',
      dnsRange: state.dnsRange || current.dnsRange || '24h',
      trafficRange: state.trafficRange || current.trafficRange || '24h',
    });
  });

  socket.on('disconnect', () => {
    socketViewState.delete(socket.id);
  });

  socket.on('run_update', async () => {
    console.log("run_update event received!");
    const updateStarted = Date.now();
    const phaseMs = { download: 0, process: 0, rule: 0, defrag: 0 };
    try {
      let phaseStart = Date.now();
      await runScript(["download_lists.js"], socket);
      phaseMs.download = Date.now() - phaseStart;

      phaseStart = Date.now();
      await runScript(["cf_list_create.js"], socket);
      phaseMs.process = Date.now() - phaseStart;

      phaseStart = Date.now();
      await runScript(["cf_gateway_rule_create.js"], socket);
      phaseMs.rule = Date.now() - phaseStart;
      
      // Auto-defragment after sync (if enabled) to clean up any empty lists
      if (CZGS_AUTO_DEFRAGMENT) {
        phaseStart = Date.now();
        socket.emit('log', "\n\x1b[36m--- Running Auto-Defragment ---\x1b[0m\n");
        const { emptyLists, nonEmptyLists, stats } = await defragmentZeroTrustLists();
        
        if (emptyLists.length > 0) {
          socket.emit('log', `\x1b[32mFound ${emptyLists.length} empty list(s) to clean up\x1b[0m\n`);
          await upsertZeroTrustDNSRule(nonEmptyLists, "CZGS Filter Lists");
          if (BLOCK_BASED_ON_SNI) {
            await upsertZeroTrustSNIRule(nonEmptyLists, "CZGS Filter Lists - SNI Based Filtering");
          }
          await deleteZeroTrustListsOneByOne(emptyLists);
          socket.emit('log', `\x1b[32mAuto-defragment complete: deleted ${emptyLists.length} empty lists\x1b[0m\n`);
        } else {
          socket.emit('log', "\x1b[32mNo empty lists found - defragment skipped\x1b[0m\n");
        }
        phaseMs.defrag = Date.now() - phaseStart;
      } else {
        socket.emit('log', "\n\x1b[33mAuto-defragment disabled (set CZGS_AUTO_DEFRAGMENT=1 to enable)\x1b[0m\n");
      }

      const totalMs = Date.now() - updateStarted;
      const defragPart = phaseMs.defrag
        ? ` | Defragment: ${formatDuration(phaseMs.defrag)}`
        : "";
      const summary =
        `\x1b[32mTiming — Download: ${formatDuration(phaseMs.download)} | ` +
        `Process: ${formatDuration(phaseMs.process)} | ` +
        `Rule: ${formatDuration(phaseMs.rule)}${defragPart} | ` +
        `Total: ${formatDuration(totalMs)}\x1b[0m\n`;
      socket.emit("log", summary);
      console.log(summary.replace(/\x1b\[[0-9;]*m/g, ""));
    } catch (err) {
      socket.emit("log", `\x1b[31mError during update: ${err.message}\x1b[0m\n`);
    } finally {
      socket.emit("update_complete");
    }
  });

  socket.on('full_reset', async () => {
    try {
      socket.emit('log', "\x1b[33mStarting full reset...\x1b[0m\n");
      const { result: rules } = await getZeroTrustRules();
      const czgsRules = (rules ?? []).filter(({ name }) => isGeneratedRuleName(name));
      
      for (const rule of czgsRules) {
        socket.emit('log', `Deleting rule: ${rule.name}\n`);
        await deleteZeroTrustRule(rule.id);
      }

      const { result: lists } = await getZeroTrustLists();
      const czgsLists = (lists ?? []).filter(({ name }) => isGeneratedListName(name));
      if (czgsLists.length > 0) {
        socket.emit('log', `Deleting ${czgsLists.length} lists...\n`);
        await deleteZeroTrustListsOneByOne(czgsLists);
      }
      
      socket.emit('log', "\n\x1b[33mCustom allowlist/denylist, DNS rewrites, and their custom rules were preserved.\x1b[0m\n");
      socket.emit('log', "\x1b[33mPlease click Quick Update to recreate generated block lists and rules.\x1b[0m\n");
    } catch (err) {
      socket.emit("log", `\x1b[31mError during full reset: ${err.message}\x1b[0m\n`);
    } finally {
      socket.emit("update_complete");
    }
  });

  // Defragment Lists API
  socket.on('run_defragment', async () => {
    try {
      socket.emit('log', "\x1b[36m--- Starting Defragment ---\x1b[0m\n");
      socket.emit('log', "\x1b[36mDefragmenting lists...\x1b[0m\n");
      
      const { emptyLists, nonEmptyLists, stats } = await defragmentZeroTrustLists();
      
      socket.emit('log', `\x1b[32mDefragmented ${stats.chunks} lists → ${stats.assignedLists} lists\x1b[0m\n`);
      socket.emit('log', `\x1b[32mMoved ${stats.entriesToMove} entries across ${stats.patches} patches\x1b[0m\n`);

      if (emptyLists.length > 0) {
        socket.emit('log', "\x1b[36mUpdating rules to exclude empty lists...\x1b[0m\n");
        await upsertZeroTrustDNSRule(nonEmptyLists, "CZGS Filter Lists");
        socket.emit('log', `\x1b[32mUpdated DNS rule using ${stats.nonEmptyLists} non-empty lists\x1b[0m\n`);

        if (BLOCK_BASED_ON_SNI) {
          await upsertZeroTrustSNIRule(nonEmptyLists, "CZGS Filter Lists - SNI Based Filtering");
          socket.emit('log', "\x1b[32mUpdated SNI rule\x1b[0m\n");
        }

        socket.emit('log', `\x1b[36mDeleting ${emptyLists.length} empty list(s)...\x1b[0m\n`);
        await deleteZeroTrustListsOneByOne(emptyLists);
        socket.emit('log', `\x1b[32mDeleted ${emptyLists.length} empty lists\x1b[0m\n`);
      } else {
        socket.emit('log', "\x1b[33mNo empty lists to clean up.\x1b[0m\n");
      }

      socket.emit('log', "\x1b[32m=== Defragment complete ===\x1b[0m\n");
    } catch (err) {
      socket.emit('log', `\x1b[31mError during defragment: ${err.message}\x1b[0m\n`);
    } finally {
      socket.emit("update_complete");
    }
  });

  // IPv4 Gateway Location Management API
  socket.on('get_gateway_location_ipv4', async () => {
    const locationId = await getGatewayLocationId(socket);
    if (!locationId) {
      socket.emit('gateway_location_ipv4_error', { error: 'CLOUDFLARE_GATEWAY_LOCATION_ID not configured' });
      return;
    }
    try {
      socket.emit('log', `\x1b[36mLoading Cloudflare Gateway location ${locationId}...\x1b[0m\n`);
      const response = await requestGateway(`/locations/${locationId}`, { method: "GET" });
      if (response?.success === false) throw new Error(JSON.stringify(response.errors));

      const location = response?.result;
      if (!location?.id) throw new Error("Cloudflare did not return a Gateway location.");

      const data = serializeGatewayLocationIpv4(location);
      socket.emit('log', `\x1b[32mLoaded location "${data.locationName}". Protected source IPv4 network: ${data.protectedNetwork || "none"}\x1b[0m\n`);
      socket.emit('log', `DNS endpoints: IPv4 ${data.dnsEndpoints.ipv4.value || "unavailable"}, IPv6 ${data.dnsEndpoints.ipv6.value || "unavailable"}, DoT ${data.dnsEndpoints.dot.value || "unavailable"}, DoH ${data.dnsEndpoints.doh.value || "unavailable"}\n`);
      socket.emit('log', `Cloudflare response: ${JSON.stringify({ success: response.success, result: { id: location.id, name: location.name, networks: location.networks, ipv4_destination: location.ipv4_destination, ipv4_destination_backup: location.ipv4_destination_backup, ip: location.ip, doh_subdomain: location.doh_subdomain, updated_at: location.updated_at } }, null, 2)}\n`);
      socket.emit('gateway_location_ipv4_data', data);
    } catch (e) {
      socket.emit('log', `\x1b[31mFailed to load Cloudflare Gateway location: ${e.message}\x1b[0m\n`);
      socket.emit('gateway_location_ipv4_error', { error: e.message });
    }
  });

  socket.on('update_gateway_location_ipv4', async ({ ipv4 }) => {
    const locationId = await getGatewayLocationId(socket);
    if (!locationId) {
      socket.emit('gateway_location_ipv4_error', { error: 'CLOUDFLARE_GATEWAY_LOCATION_ID not configured' });
      return;
    }
    const cleanIpv4 = String(ipv4 || "").trim();
    try {
      if (isIP(cleanIpv4) !== 4) {
        throw new Error("Enter a valid IPv4 address.");
      }

      const newNetwork = `${cleanIpv4}/32`;
      socket.emit('log', `\x1b[36mFetching current Cloudflare Gateway location before update...\x1b[0m\n`);
      const currentResponse = await requestGateway(`/locations/${locationId}`, { method: "GET" });
      if (currentResponse?.success === false) throw new Error(JSON.stringify(currentResponse.errors));

      const currentLocation = currentResponse?.result;
      if (!currentLocation?.id) throw new Error("Cloudflare did not return a Gateway location.");

      const oldNetwork = getPrimaryIpv4Network(currentLocation) || "none";
      socket.emit('log', `Current protected source IPv4 network: ${oldNetwork}\n`);
      socket.emit('log', `Requested protected source IPv4 network: ${newNetwork}\n`);

      const updatePayload = buildGatewayLocationUpdatePayload(currentLocation, newNetwork);
      const updateResponse = await requestGateway(`/locations/${locationId}`, {
        method: "PUT",
        body: JSON.stringify(updatePayload),
      });
      if (updateResponse?.success === false) throw new Error(JSON.stringify(updateResponse.errors));

      const updatedLocation = updateResponse?.result;
      if (!updatedLocation?.id) throw new Error("Cloudflare did not return the updated Gateway location.");

      const data = serializeGatewayLocationIpv4(updatedLocation);
      socket.emit('log', `\x1b[32mCloudflare Gateway location updated successfully.\x1b[0m\n`);
      socket.emit('log', `\x1b[32mProtected source IPv4 network is now ${data.protectedNetwork || newNetwork}${data.updatedAt ? ` (updated ${data.updatedAt})` : ""}.\x1b[0m\n`);
      socket.emit('log', `DNS endpoints: IPv4 ${data.dnsEndpoints.ipv4.value || "unavailable"}, IPv6 ${data.dnsEndpoints.ipv6.value || "unavailable"}, DoT ${data.dnsEndpoints.dot.value || "unavailable"}, DoH ${data.dnsEndpoints.doh.value || "unavailable"}\n`);
      socket.emit('log', `Cloudflare response: ${JSON.stringify({ success: updateResponse.success, result: { id: updatedLocation.id, name: updatedLocation.name, networks: updatedLocation.networks, ipv4_destination: updatedLocation.ipv4_destination, ipv4_destination_backup: updatedLocation.ipv4_destination_backup, ip: updatedLocation.ip, doh_subdomain: updatedLocation.doh_subdomain, updated_at: updatedLocation.updated_at } }, null, 2)}\n`);
      socket.emit('gateway_location_ipv4_updated', { success: true, ...data });
    } catch (e) {
      socket.emit('log', `\x1b[31mIPv4 location update failed: ${e.message}\x1b[0m\n`);
      socket.emit('gateway_location_ipv4_updated', { success: false, error: e.message });
    }
  });

  // URL Management API
  socket.on('get_urls', (type) => { // type: 'blocklist' | 'allowlist'
    const key = type === 'blocklist' ? 'BLOCKLIST_URLS' : 'ALLOWLIST_URLS';
    let urls = readEnvUrls(key);
    
    // If no URLs are found in .env, fall back to the recommended defaults
    if (urls.length === 0) {
      urls = type === 'blocklist' ? RECOMMENDED_BLOCKLIST_URLS : RECOMMENDED_ALLOWLIST_URLS;
    }
    
    socket.emit('urls_data', { type, urls });
  });

  socket.on('save_urls', ({ type, urls }) => {
    try {
      const key = type === 'blocklist' ? 'BLOCKLIST_URLS' : 'ALLOWLIST_URLS';
      writeEnvUrls(key, urls);
      socket.emit('urls_saved', { success: true });
    } catch (e) {
      socket.emit('urls_saved', { success: false, error: e.message });
    }
  });

  // Allowlist Management API
  socket.on('get_custom_allowlist', async () => {
    try {
      const { result: lists } = await getZeroTrustLists();
      let customList = findCustomAllowlist(lists);
      if (!customList) {
        // Create if not exists
        const created = await requestGateway("/lists", {
          method: "POST",
          body: JSON.stringify({
            name: CUSTOM_ALLOWLIST_NAME,
            type: "DOMAIN",
            description: "Custom allowlist managed by the dashboard",
            items: [],
          }),
        });
        if (!created?.result?.id) throw new Error("Failed to create list.");
        customList = created.result;
        socket.emit('log', `\x1b[32mCreated custom allowlist "${CUSTOM_ALLOWLIST_NAME}".\x1b[0m\n`);
      } else {
        socket.emit('log', `\x1b[32mUsing existing custom allowlist "${customList.name}".\x1b[0m\n`);
      }

      const allowRuleAction = await upsertAllowRule(customList.id);
      socket.emit('log', `\x1b[32mCustom allow rule ${allowRuleAction}.\x1b[0m\n`);
      
      // Only show the warning if the rule was just created
      if (allowRuleAction === "created") {
        socket.emit('log', `\x1b[33m${RULE_ORDER_WARNING}\x1b[0m\n`);
      }

      const items = await fetchCustomListItems(customList.id);
      socket.emit('custom_allowlist_data', { id: customList.id, items });
    } catch (e) {
      socket.emit('custom_allowlist_error', { error: e.message });
    }
  });

  socket.on('manage_allowlist', async ({ action, listId, domains }) => {
    try {
      const finalDomains = await prepareCustomListDomains({ action, listId, domains, socket });
      if (finalDomains.length === 0) return;

      socket.emit('log', `\x1b[34mProcessing ${action} for ${finalDomains.length} domain(s)...\x1b[0m\n`);
      const patchData = action === 'add'
        ? { append: finalDomains.map(d => ({ value: d })) }
        : { remove: finalDomains };

      await patchExistingListChunked(listId, patchData, 'Custom Allowlist');

      const allowRuleAction = await upsertAllowRule(listId);
      socket.emit('log', `\x1b[32mSuccessfully updated allowlist and rule (${allowRuleAction}).\x1b[0m\n`);
    } catch (e) {
      socket.emit('log', `\x1b[31mAllowlist update failed: ${e.message}\x1b[0m\n`);
    } finally {
      socket.emit('manage_allowlist_success');
    }
  });

  // Denylist Management API
  socket.on('get_custom_denylist', async () => {
    try {
      const { result: lists } = await getZeroTrustLists();
      let customList = findCustomDenylist(lists);
      if (!customList) {
        const created = await requestGateway("/lists", {
          method: "POST",
          body: JSON.stringify({
            name: CUSTOM_DENYLIST_NAME,
            type: "DOMAIN",
            description: "Custom denylist managed by the dashboard",
            items: [],
          }),
        });
        if (!created?.result?.id) throw new Error("Failed to create list.");
        customList = created.result;
        socket.emit('log', `\x1b[32mCreated custom denylist "${CUSTOM_DENYLIST_NAME}".\x1b[0m\n`);
      } else {
        socket.emit('log', `\x1b[32mUsing existing custom denylist "${customList.name}".\x1b[0m\n`);
      }

      const denyRuleAction = await upsertDenyRule(customList.id);
      socket.emit('log', `\x1b[32mCustom deny rule ${denyRuleAction}.\x1b[0m\n`);

      const items = await fetchCustomListItems(customList.id);
      socket.emit('custom_denylist_data', { id: customList.id, items });
    } catch (e) {
      socket.emit('custom_denylist_error', { error: e.message });
    }
  });

  socket.on('manage_denylist', async ({ action, listId, domains }) => {
    try {
      const finalDomains = await prepareCustomListDomains({ action, listId, domains, socket });
      if (finalDomains.length === 0) return;

      socket.emit('log', `\x1b[34mProcessing ${action} for ${finalDomains.length} domain(s)...\x1b[0m\n`);
      const patchData = action === 'add'
        ? { append: finalDomains.map(d => ({ value: d })) }
        : { remove: finalDomains };

      await patchExistingListChunked(listId, patchData, 'Custom Denylist');

      const denyRuleAction = await upsertDenyRule(listId);
      socket.emit('log', `\x1b[32mSuccessfully updated denylist and rule (${denyRuleAction}).\x1b[0m\n`);
    } catch (e) {
      socket.emit('log', `\x1b[31mDenylist update failed: ${e.message}\x1b[0m\n`);
    } finally {
      socket.emit('manage_denylist_success');
    }
  });

  // DNS Rewrite Management API
  socket.on('get_dns_rewrites', async () => {
    try {
      const { result: rules } = await getZeroTrustRules();
      const rewrites = (rules ?? [])
        .filter(({ name }) => isDnsRewriteRuleName(name))
        .map(serializeDnsRewriteRule)
        .filter(({ domain, ips }) => domain && ips.length > 0)
        .sort((a, b) => a.domain.localeCompare(b.domain));

      socket.emit('dns_rewrites_data', { rewrites });
    } catch (e) {
      socket.emit('dns_rewrites_error', { error: e.message });
    }
  });

  socket.on('save_dns_rewrites', async ({ raw }) => {
    try {
      const { entries, invalid } = parseRewriteLines(raw);

      for (const item of invalid) {
        socket.emit('log', `\x1b[33mSkipping rewrite line ${item.line}: ${item.reason} (${item.value})\x1b[0m\n`);
      }

      const { result: rules } = await getZeroTrustRules();
      const existingRewriteRules = (rules ?? []).filter(({ name }) => isDnsRewriteRuleName(name));
      const existingByDomain = new Map(
        existingRewriteRules.map(rule => [getRewriteDomainFromRule(rule), rule])
      );
      const desiredDomains = new Set(entries.map(({ domain }) => domain));

      let created = 0;
      let updated = 0;
      let deleted = 0;

      for (const entry of entries) {
        const action = await upsertDnsRewriteRule(entry, existingByDomain.get(entry.domain));
        if (action === "created") created++;
        else updated++;
      }

      for (const rule of existingRewriteRules) {
        const domain = getRewriteDomainFromRule(rule);
        if (domain && !desiredDomains.has(domain)) {
          await deleteZeroTrustRule(rule.id);
          deleted++;
        }
      }

      socket.emit('log', `\x1b[32mDNS rewrites saved: ${created} created, ${updated} updated, ${deleted} deleted.\x1b[0m\n`);
      socket.emit('dns_rewrites_saved', { success: true, invalidCount: invalid.length });
    } catch (e) {
      socket.emit('dns_rewrites_saved', { success: false, error: e.message });
      socket.emit('log', `\x1b[31mDNS rewrite save failed: ${e.message}\x1b[0m\n`);
    }
  });

  // DNS Analytics cache query functions
  function getDNSAnalyticsFromCache(range = '24h') {
    const nowSec = Math.floor(Date.now() / 1000);
    const cutoffSec = getCutoffForRange(range);
    
    // Check if we have any data
    const hasData = db.prepare('SELECT 1 FROM dns_timeseries WHERE bucket_ts >= ? LIMIT 1').get(cutoffSec);
    if (!hasData) return null;
    
    // Get sync state
    const syncState = db.prepare('SELECT last_synced_ts FROM sync_state WHERE key = ?').get('dns_analytics');
    const cachedAt = syncState?.last_synced_ts ? new Date(syncState.last_synced_ts * 1000).toISOString() : null;
    
    // Determine bucket aggregation based on range
    let bucketIntervalSec;
    switch (range) {
      case '7d': bucketIntervalSec = 60 * 60; break; // 1 hour buckets
      case '30d': bucketIntervalSec = 6 * 60 * 60; break; // 6 hour buckets
      case '24h':
      default: bucketIntervalSec = 15 * 60; break; // 15 min buckets
    }
    
    // Build time series from cache with appropriate bucketing
    const timeSeriesQuery = `
      SELECT 
        (bucket_ts / ?) * ? as aggregated_bucket,
        SUM(count) as count
      FROM dns_timeseries
      WHERE bucket_ts >= ?
      GROUP BY aggregated_bucket
      ORDER BY aggregated_bucket ASC
    `;
    const tsStmt = db.prepare(timeSeriesQuery);
    const tsRows = tsStmt.all(bucketIntervalSec, bucketIntervalSec, cutoffSec);
    
    const timeSeries = tsRows.map(row => ({
      time: new Date(row.aggregated_bucket * 1000).toISOString(),
      count: row.count
    }));
    
    const totalCount = timeSeries.reduce((sum, item) => sum + (item.count || 0), 0);
    
    // Aggregate top domains
    const domainsStmt = db.prepare(`
      SELECT domain, SUM(count) as total
      FROM dns_top_domains
      WHERE bucket_ts >= ?
      GROUP BY domain
      ORDER BY total DESC
      LIMIT 10
    `);
    const topDomains = domainsStmt.all(cutoffSec).map(r => ({ domain: r.domain, count: r.total }));
    
    // Aggregate top locations
    const locationsStmt = db.prepare(`
      SELECT location, SUM(count) as total
      FROM dns_top_locations
      WHERE bucket_ts >= ?
      GROUP BY location
      ORDER BY total DESC
      LIMIT 10
    `);
    const topLocations = locationsStmt.all(cutoffSec).map(r => ({ location: r.location, count: r.total }));
    
    // Aggregate resolver decisions
    const decisionsStmt = db.prepare(`
      SELECT decision, SUM(count) as total
      FROM dns_resolver_decisions
      WHERE bucket_ts >= ?
      GROUP BY decision
      ORDER BY total DESC
    `);
    const RESOLVER_DECISION_LABELS = {
      '5': 'Allowed on no policy match',
      '9': 'Blocked rule',
      '10': 'Allowed rule',
    };
    const resolverDecisions = decisionsStmt.all(cutoffSec).map(r => ({
      metric: r.decision,
      label: RESOLVER_DECISION_LABELS[r.decision] || `Decision ${r.decision}`,
      count: r.total
    }));
    
    return {
      timeSeries,
      totalCount,
      topDomains,
      topLocations,
      resolverDecisions,
      cachedAt,
      source: 'cache'
    };
  }

  // DNS Analytics API - cache first, then live
  socket.on('get_dns_analytics', async ({ range = '24h', skipLive = false }) => {
    try {
      const currentState = socketViewState.get(socket.id) || {};
      socketViewState.set(socket.id, { ...currentState, dnsRange: range });
      // 1. Emit cached data immediately if available
      const cached = getDNSAnalyticsFromCache(range);
      if (cached) {
        socket.emit('dns_analytics_data', {
          success: true,
          ...cached,
          range,
        });
      } else if (range !== '24h') {
        socket.emit('dns_analytics_data', {
          success: true,
          timeSeries: [],
          totalCount: 0,
          topDomains: [],
          topLocations: [],
          resolverDecisions: [],
          range,
          source: 'cache',
          cachedAt: null,
        });
      } else if (!skipLive) {
        // No cache and not skipping live - show loading state
        socket.emit('dns_analytics_data', {
          success: true,
          timeSeries: [],
          totalCount: 0,
          topDomains: [],
          topLocations: [],
          resolverDecisions: [],
          range,
          source: 'loading',
          cachedAt: null,
        });
      }
      
      if (skipLive || range !== '24h') return;
      
      // 3. Fetch live data from Cloudflare
      const hours = 24;
      const [timeSeriesData, topDomains, topLocations, resolverDecisions] = await Promise.all([
        fetchDNSTimeSeriesData(hours),
        fetchTopDomains(10),
        fetchTopLocations(10),
        fetchResolverDecisions(),
      ]);
      
      // 4. Emit live data
      socket.emit('dns_analytics_data', {
        success: true,
        timeSeries: timeSeriesData.timeSeries,
        totalCount: timeSeriesData.totalCount,
        startTime: timeSeriesData.startTime,
        endTime: timeSeriesData.endTime,
        topDomains,
        topLocations,
        resolverDecisions,
        range,
        source: 'live',
        cachedAt: new Date().toISOString(),
      });
    } catch (e) {
      console.error('DNS analytics error:', e);
      socket.emit('dns_analytics_data', {
        success: false,
        error: e.message,
        range: range || '24h',
      });
    }
  });

  // Traffic Map API - cache first, then live
  socket.on('get_traffic_map', async (options = {}) => {
    try {
      const { force, range = '24h' } = options;
      const currentState = socketViewState.get(socket.id) || {};
      socketViewState.set(socket.id, { ...currentState, trafficRange: range });
      await emitTrafficMapData(socket, range, 'cache');
      if (force || !isTrafficMapGraphQLSyncFresh()) {
        try {
          await syncTrafficMapAggregatesToDatabase();
        } catch (syncError) {
          console.warn('Traffic map GraphQL sync failed; falling back to raw activity log sync:', syncError.message);
          await syncTrafficLogsToDatabase(Boolean(force));
        }
      }
      await emitTrafficMapData(socket, range, 'live');
    } catch (e) {
      console.error('Traffic map error:', e);
      socket.emit('traffic_map_data', { success: false, error: e.message, range: options?.range || '24h' });
    }
  });
});

const PORT = process.env.PORT || 3333;
const HOST = process.env.HOST || (existsSync("/.dockerenv") ? "0.0.0.0" : "127.0.0.1");

logDashboardSecurityWarning();

// Boot logs - DB status and persistence info
function logDatabaseStatus() {
  try {
    const dbPath = join(DATA_DIR, 'traffic_logs.db');
    console.log(`[DB] Database path: ${dbPath}`);
    
    // Check traffic logs
    const logsCount = db.prepare('SELECT COUNT(*) as cnt FROM logs').get().cnt;
    const logsRange = db.prepare('SELECT MIN(datetime) as min_ts, MAX(datetime) as max_ts FROM logs').get();
    console.log(`[DB] Traffic logs: ${logsCount} entries` + 
      (logsRange.min_ts ? ` (${new Date(logsRange.min_ts * 1000).toISOString()} to ${new Date(logsRange.max_ts * 1000).toISOString()})` : ''));
    
    // Check DNS analytics cache
    const dnsCount = db.prepare('SELECT COUNT(*) as cnt FROM dns_timeseries').get().cnt;
    const dnsRange = db.prepare('SELECT MIN(bucket_ts) as min_ts, MAX(bucket_ts) as max_ts FROM dns_timeseries').get();
    console.log(`[DB] DNS analytics: ${dnsCount} buckets` +
      (dnsRange.min_ts ? ` (${new Date(dnsRange.min_ts * 1000).toISOString()} to ${new Date(dnsRange.max_ts * 1000).toISOString()})` : ''));
    
    // Check sync state
    const syncStates = db.prepare('SELECT key, last_synced_ts, oldest_synced_ts FROM sync_state').all();
    for (const s of syncStates) {
      console.log(`[DB] Sync state '${s.key}': last=${s.last_synced_ts ? new Date(s.last_synced_ts * 1000).toISOString() : 'never'}, oldest=${s.oldest_synced_ts ? new Date(s.oldest_synced_ts * 1000).toISOString() : 'never'}`);
    }
    
    console.log(`[DB] Persistence: Data stored in Docker volume 'czgs-data' → survives restarts, image updates, and host reboots`);
    console.log(`[DB] WARNING: 'docker compose down -v' or 'docker volume rm czgs-data' will DELETE all data!`);
  } catch (e) {
    console.error('[DB] Error checking database status:', e.message);
  }
}

httpServer.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  logDatabaseStatus();
});
