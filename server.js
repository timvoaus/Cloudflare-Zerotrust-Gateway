import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { fileURLToPath } from 'url';
import geoip from 'geoip-lite';
import { DatabaseSync } from 'node:sqlite';

import dotenv from 'dotenv';
// Load .env if it exists, but don't overwrite existing environment variables (important for Docker)
dotenv.config({ override: false });

// Import constants for DNS analytics
import { ACCOUNT_ID, API_TOKEN } from './lib/constants.js';

// Ensure .env is read properly to load API credentials
// For dynamic requests to Cloudflare Gateway APIs:
import {
  getZeroTrustLists,
  getZeroTrustRules,
  deleteZeroTrustListsOneByOne,
  deleteZeroTrustRule,
} from './lib/api.js';
import { requestGateway } from './lib/helpers.js';
import { 
  RECOMMENDED_ALLOWLIST_URLS, 
  RECOMMENDED_BLOCKLIST_URLS 
} from './lib/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, 'data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR);

const db = new DatabaseSync(join(DATA_DIR, 'traffic_logs.db'));
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
`);

const app = express();
const httpServer = createServer(app);

const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME || "admin";
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || process.env.CZGS_DASHBOARD_PASSWORD || "";
const DASHBOARD_AUTH_DISABLED = process.env.DASHBOARD_AUTH_DISABLED === "1";
const DASHBOARD_ALLOWED_ORIGINS = (process.env.DASHBOARD_ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseBasicAuth(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return null;

  try {
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");
    if (separatorIndex === -1) return null;

    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1),
    };
  } catch {
    return null;
  }
}

function isLoopbackRequest(req) {
  const remoteAddress = req.socket?.remoteAddress || "";
  return remoteAddress === "::1" || remoteAddress === "127.0.0.1" || remoteAddress === "::ffff:127.0.0.1";
}

function isDashboardRequestAuthorized(req) {
  if (DASHBOARD_AUTH_DISABLED) return true;

  if (!DASHBOARD_PASSWORD) {
    return isLoopbackRequest(req);
  }

  const credentials = parseBasicAuth(req);
  return !!credentials &&
    safeEqual(credentials.username, DASHBOARD_USERNAME) &&
    safeEqual(credentials.password, DASHBOARD_PASSWORD);
}

function requireDashboardAccess(req, res, next) {
  if (isDashboardRequestAuthorized(req)) return next();

  if (DASHBOARD_PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="CZGS Dashboard", charset="UTF-8"');
    return res.status(401).send("Authentication required.");
  }

  return res.status(403).send(
    "Remote dashboard access is blocked by default. Set DASHBOARD_PASSWORD to enable authenticated remote access."
  );
}

const socketOptions = {
  allowRequest: (req, callback) => {
    if (isDashboardRequestAuthorized(req)) return callback(null, true);
    return callback("Unauthorized dashboard request", false);
  },
};

if (DASHBOARD_ALLOWED_ORIGINS.length > 0) {
  socketOptions.cors = {
    origin: DASHBOARD_ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
    credentials: true,
  };
}

const io = new Server(httpServer, socketOptions);

app.use(requireDashboardAccess);
app.use(express.static(join(__dirname, 'public')));
app.use('/vendor/chart.js', express.static(join(__dirname, 'node_modules', 'chart.js', 'dist')));
app.use('/vendor/d3', express.static(join(__dirname, 'node_modules', 'd3', 'dist')));
app.use('/vendor/topojson-client', express.static(join(__dirname, 'node_modules', 'topojson-client', 'dist')));
app.use('/vendor/world-atlas', express.static(join(__dirname, 'node_modules', 'world-atlas')));
app.use(express.json());

// Settings endpoint removed. Configure via .env or environment variables.

const CUSTOM_ALLOWLIST_NAME = "Gateway Custom Allowlist";
const CUSTOM_ALLOW_RULE_NAME = "Gateway Custom Allow Rule";
const CUSTOM_DENYLIST_NAME = "Gateway Custom Denylist";
const CUSTOM_DENY_RULE_NAME = "Gateway Custom Deny Rule";
const DNS_REWRITE_RULE_PREFIX = "Gateway DNS Rewrite - ";
const DNS_REWRITE_RULE_DESCRIPTION = "DNS rewrite managed by the dashboard. Avoid editing this rule name.";
const GENERATED_LIST_NAME_PREFIX = "CZGS List";
const GENERATED_RULE_NAME_PREFIX = "CZGS Filter Lists";
const RULE_ORDER_WARNING = `IMPORTANT: In Cloudflare Zero Trust > Gateway > Firewall Policies > DNS, move "${CUSTOM_ALLOW_RULE_NAME}" above "${GENERATED_RULE_NAME_PREFIX}". Rules are evaluated top-to-bottom, so the custom allow rule must be first.`;

function isGeneratedListName(name) {
  return name.startsWith(GENERATED_LIST_NAME_PREFIX);
}

function isGeneratedRuleName(name) {
  return name.startsWith(GENERATED_RULE_NAME_PREFIX);
}

function isDnsRewriteRuleName(name) {
  return name.startsWith(DNS_REWRITE_RULE_PREFIX);
}

function isCustomAllowlistName(name) {
  return name === CUSTOM_ALLOWLIST_NAME || (name.endsWith("Custom Allowlist") && !name.startsWith("CZGS"));
}

function isCustomDenylistName(name) {
  return name === CUSTOM_DENYLIST_NAME || (name.endsWith("Custom Denylist") && !name.startsWith("CZGS"));
}

function isCustomAllowRuleName(name) {
  return name === CUSTOM_ALLOW_RULE_NAME || (name.endsWith("Custom Allow Rule") && !name.startsWith("CZGS"));
}

function isCustomDenyRuleName(name) {
  return name === CUSTOM_DENY_RULE_NAME || (name.endsWith("Custom Deny Rule") && !name.startsWith("CZGS"));
}

function findCustomAllowlist(lists = []) {
  return lists.find(({ name }) => name === CUSTOM_ALLOWLIST_NAME)
    || lists.find(({ name }) => isCustomAllowlistName(name) && !isGeneratedListName(name));
}

function findCustomDenylist(lists = []) {
  return lists.find(({ name }) => name === CUSTOM_DENYLIST_NAME)
    || lists.find(({ name }) => isCustomDenylistName(name) && !isGeneratedListName(name));
}

function normalizeRewriteDomain(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
}

function escapeWirefilterString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isValidRewriteDomain(value) {
  const DOMAIN_RE = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  return DOMAIN_RE.test(value);
}

function parseRewriteLines(raw) {
  const entries = [];
  const invalid = [];
  const lines = String(raw || "").split(/\r?\n/);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const normalizedLine = trimmed
      .replace(/\s*->\s*/, " ")
      .replace(/\s*=\s*/, " ")
      .replace(/\s+/g, " ");
    const [domainValue, ...ipValues] = normalizedLine.split(/[,\s]+/).filter(Boolean);
    const domain = normalizeRewriteDomain(domainValue);
    const ips = [...new Set(ipValues.map(ip => ip.trim()).filter(Boolean))];

    if (!isValidRewriteDomain(domain)) {
      invalid.push({ line: index + 1, value: trimmed, reason: "Invalid domain" });
      return;
    }

    if (ips.length === 0 || ips.some(ip => isIP(ip) === 0)) {
      invalid.push({ line: index + 1, value: trimmed, reason: "Invalid IP address" });
      return;
    }

    entries.push({ domain, ips });
  });

  const byDomain = new Map();
  for (const entry of entries) {
    byDomain.set(entry.domain, entry);
  }

  return { entries: [...byDomain.values()], invalid };
}

function getRewriteDomainFromRule(rule) {
  if (rule.name?.startsWith(DNS_REWRITE_RULE_PREFIX)) {
    return normalizeRewriteDomain(rule.name.slice(DNS_REWRITE_RULE_PREFIX.length));
  }

  const match = String(rule.traffic || "").match(/dns\.fqdn\s*==\s*"((?:\\"|[^"])*)"/);
  return match ? normalizeRewriteDomain(match[1].replace(/\\"/g, '"')) : "";
}

function getRewriteIpsFromRule(rule) {
  return Array.isArray(rule.rule_settings?.override_ips) ? rule.rule_settings.override_ips : [];
}

// Helper to spawn and stream output
function runScript(scriptArgs, socket) {
  return new Promise((resolvePromise, rejectPromise) => {
    socket.emit('log', `\x1b[36m> node ${scriptArgs.join(' ')}\x1b[0m\n`);
    
    // Strip list URL keys so they are re-read fresh
    const { BLOCKLIST_URLS, ALLOWLIST_URLS, ...inheritedEnv } = process.env;
    const child = spawn("node", scriptArgs, {
      env: { ...inheritedEnv },
    });

    child.stdout.on("data", (data) => socket.emit("log", data.toString()));
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
  const envPath = resolve("./.env");
  if (!existsSync(envPath)) return [];
  const content = readFileSync(envPath, "utf8");
  
  const quotedMatch = content.match(new RegExp(`^(?:#\\s*)?${key}="([\\s\\S]*?)"`, "m"));
  if (quotedMatch) return quotedMatch[1].split("\n").map(u => u.trim()).filter(Boolean);
  
  const singleMatch = content.match(new RegExp(`^(?:#\\s*)?${key}=(.+)$`, "m"));
  if (singleMatch) return singleMatch[1].trim().split(/\\n/).map(u => u.trim()).filter(Boolean);
  
  return [];
}

function writeEnvUrls(key, urls) {
  const envPath = resolve("./.env");
  if (!existsSync(envPath)) throw new Error(".env file not found");
  
  let content = readFileSync(envPath, "utf8");
  const value = `"${urls.join("\n")}"`;
  const newLine = `${key}=${value}`;
  
  const quotedPattern = new RegExp(`^(?:#\\s*)?${key}="[\\s\\S]*?"`, "m");
  const singlePattern = new RegExp(`^(?:#\\s*)?${key}=.*$`, "m");
  
  if (quotedPattern.test(content)) content = content.replace(quotedPattern, newLine);
  else if (singlePattern.test(content)) content = content.replace(singlePattern, newLine);
  else content = `${content}\n${newLine}`;
  
  writeFileSync(envPath, content, "utf8");
}

// Allowlist Helpers
async function fetchCustomListItems(listId) {
  const { result } = await requestGateway(`/lists/${listId}/items?per_page=1000`, { method: "GET" });
  return (result ?? []).map((item) => item.value);
}

async function upsertAllowRule(listId) {
  const allowExpression = `any(dns.domains[*] in $${listId})`;
  const { result: existingRules } = await getZeroTrustRules();
  const existingAllowRule = existingRules?.find(({ name }) => name === CUSTOM_ALLOW_RULE_NAME)
    || existingRules?.find(({ name }) => isCustomAllowRuleName(name) && !isGeneratedRuleName(name));

  const rulePayload = {
    name: CUSTOM_ALLOW_RULE_NAME,
    description: `Custom allow list managed by the dashboard. Must be ordered above ${GENERATED_RULE_NAME_PREFIX}.`,
    enabled: true,
    action: "allow",
    filters: ["dns"],
    traffic: allowExpression,
  };

  if (existingAllowRule) {
    await requestGateway(`/rules/${existingAllowRule.id}`, {
      method: "PUT",
      body: JSON.stringify(rulePayload),
    });
    return "updated";
  } else {
    await requestGateway("/rules", {
      method: "POST",
      body: JSON.stringify(rulePayload),
    });
    return "created";
  }
}

async function upsertDenyRule(listId) {
  const denyExpression = `any(dns.domains[*] in $${listId})`;
  const { result: existingRules } = await getZeroTrustRules();
  const existingDenyRule = existingRules?.find(({ name }) => name === CUSTOM_DENY_RULE_NAME)
    || existingRules?.find(({ name }) => isCustomDenyRuleName(name) && !isGeneratedRuleName(name));

  const rulePayload = {
    name: CUSTOM_DENY_RULE_NAME,
    description: "Custom deny list managed by the dashboard.",
    enabled: true,
    action: "block",
    filters: ["dns"],
    traffic: denyExpression,
  };

  if (existingDenyRule) {
    await requestGateway(`/rules/${existingDenyRule.id}`, {
      method: "PUT",
      body: JSON.stringify(rulePayload),
    });
    return "updated";
  } else {
    await requestGateway("/rules", {
      method: "POST",
      body: JSON.stringify(rulePayload),
    });
    return "created";
  }
}

async function upsertDnsRewriteRule({ domain, ips }, existingRule) {
  const rulePayload = {
    name: `${DNS_REWRITE_RULE_PREFIX}${domain}`,
    description: DNS_REWRITE_RULE_DESCRIPTION,
    enabled: true,
    action: "override",
    filters: ["dns"],
    traffic: `dns.fqdn == "${escapeWirefilterString(domain)}"`,
    rule_settings: {
      override_ips: ips,
    },
  };

  if (existingRule) {
    await requestGateway(`/rules/${existingRule.id}`, {
      method: "PUT",
      body: JSON.stringify(rulePayload),
    });
    return "updated";
  }

  await requestGateway("/rules", {
    method: "POST",
    body: JSON.stringify(rulePayload),
  });
  return "created";
}

function serializeDnsRewriteRule(rule) {
  return {
    id: rule.id,
    name: rule.name,
    domain: getRewriteDomainFromRule(rule),
    ips: getRewriteIpsFromRule(rule),
    enabled: rule.enabled !== false,
  };
}

// DNS Analytics Functions
async function fetchDNSTimeSeriesData(hours = 24) {
  const now = new Date();
  const startTime = new Date(now - hours * 60 * 60 * 1000).toISOString();
  const endTime = now.toISOString();

  // Use sparkline with ts dimension for 15-minute interval data
  const query = `
    query GetDNSTimeSeries($accountTag: string!, $start: Time!, $end: Time!) {
      viewer {
        scope: accounts(filter: { accountTag: $accountTag }) {
          sparkline: gatewayResolverQueriesAdaptiveGroups(
            filter: {
              datetime_geq: $start,
              datetime_lt: $end
            }
            limit: 5000
            orderBy: [datetimeFifteenMinutes_ASC]
          ) {
            count
            dimensions {
              ts: datetimeFifteenMinutes
            }
          }
          total: gatewayResolverQueriesAdaptiveGroups(
            filter: {
              datetime_geq: $start,
              datetime_lt: $end
            }
            limit: 1
          ) {
            count
          }
        }
      }
    }
  `;

  const variables = {
    accountTag: ACCOUNT_ID,
    start: startTime,
    end: endTime,
  };

  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await response.json();

  if (!response.ok || data.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(data.errors || data)}`);
  }

  const account = data.data?.viewer?.scope?.[0];
  const sparklineData = account?.sparkline || [];
  const totalResult = account?.total || [];

  const totalCount = totalResult.reduce((sum, item) => sum + (item.count || 0), 0);

  const intervalMs = 15 * 60 * 1000;
  const dataMap = new Map();

  sparklineData.forEach(item => {
    const time = item.dimensions?.ts;
    if (time) {
      dataMap.set(new Date(time).getTime(), item.count || 0);
    }
  });

  const startBucket = Math.ceil(new Date(startTime).getTime() / intervalMs) * intervalMs;
  const endBucket = Math.floor(new Date(endTime).getTime() / intervalMs) * intervalMs;
  const formattedData = [];

  for (let timestamp = startBucket; timestamp <= endBucket; timestamp += intervalMs) {
    const time = new Date(timestamp).toISOString();
    formattedData.push({
      time,
      count: dataMap.has(timestamp) ? dataMap.get(timestamp) : null,
    });
  }

  return { timeSeries: formattedData, totalCount, startTime, endTime };
}

function aggregateIntoTimeBuckets(data, intervalMinutes = 60) {
  if (!data || data.length === 0) return [];

  // Group data into time buckets
  const buckets = new Map();

  data.forEach(item => {
    // Handle both datetimeHour and datetimeMinute dimensions
    const timeStr = item.dimensions?.datetimeMinute || item.dimensions?.datetimeHour;
    if (!timeStr) return;

    const date = new Date(timeStr);
    
    if (intervalMinutes >= 60) {
      // For hourly or larger intervals, just use the hour as-is
      date.setMinutes(0, 0, 0);
    } else {
      // Round down to the nearest interval
      const minutes = date.getMinutes();
      const roundedMinutes = Math.floor(minutes / intervalMinutes) * intervalMinutes;
      date.setMinutes(roundedMinutes, 0, 0);
    }

    const bucketKey = date.toISOString();
    
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, { time: bucketKey, count: 0 });
    }
    
    buckets.get(bucketKey).count += item.count || 0;
  });

  // Convert to array and sort by time
  return Array.from(buckets.values()).sort((a, b) => new Date(a.time) - new Date(b.time));
}

async function fetchTopDomains(limit = 10) {
  const now = new Date();
  const startTime = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const endTime = now.toISOString();

  const query = `
    query GetTopDomains($accountTag: string!, $start: Time!, $end: Time!, $limit: Int!) {
      viewer {
        scope: accounts(filter: { accountTag: $accountTag }) {
          topDomains: gatewayResolverQueriesAdaptiveGroups(
            filter: {
              datetime_geq: $start,
              datetime_lt: $end
            }
            limit: $limit
            orderBy: [count_DESC]
          ) {
            count
            dimensions {
              queryName
            }
          }
        }
      }
    }
  `;

  const variables = {
    accountTag: ACCOUNT_ID,
    start: startTime,
    end: endTime,
    limit: limit,
  };

  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await response.json();

  if (!response.ok || data.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(data.errors || data)}`);
  }

  const account = data.data?.viewer?.scope?.[0];
  const topDomains = account?.topDomains || [];

  return topDomains
    .map(item => ({
      domain: item.dimensions?.queryName || 'N/A',
      count: item.count || 0,
    }))
    .sort((a, b) => b.count - a.count);
}

async function fetchTopLocations(limit = 10) {
  const now = new Date();
  const startTime = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const endTime = now.toISOString();

  const query = `
    query GetTopLocations($accountTag: string!, $start: Time!, $end: Time!, $limit: Int!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          topLocations: gatewayResolverQueriesAdaptiveGroups(
            filter: {
              datetime_geq: $start,
              datetime_leq: $end
            }
            limit: $limit
          ) {
            count
            dimensions {
              locationName
            }
          }
        }
      }
    }
  `;

  const variables = {
    accountTag: ACCOUNT_ID,
    start: startTime,
    end: endTime,
    limit: limit,
  };

  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await response.json();

  if (!response.ok || data.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(data.errors || data)}`);
  }

  const account = data.data?.viewer?.accounts?.[0];
  const topLocations = account?.topLocations || [];

  return topLocations.map(item => ({
    location: item.dimensions?.locationName || 'N/A',
    count: item.count || 0,
  }));
}

async function fetchResolverDecisions() {
  const now = new Date();
  const startTime = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const endTime = now.toISOString();

  const query = `
    query GetResolverDecisions($accountTag: string!, $start: Time!, $end: Time!) {
      viewer {
        scope: accounts(filter: { accountTag: $accountTag }) {
          data: gatewayResolverQueriesAdaptiveGroups(
            filter: { datetime_geq: $start, datetime_lt: $end }
            limit: 10
            orderBy: [count_DESC]
          ) {
            count
            dimensions {
              metric: resolverDecision
            }
          }
        }
      }
    }
  `;

  const variables = {
    accountTag: ACCOUNT_ID,
    start: startTime,
    end: endTime,
  };

  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await response.json();

  if (!response.ok || data.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(data.errors || data)}`);
  }

  const RESOLVER_DECISION_LABELS = {
    5: 'Allowed on no policy match',
    9: 'Blocked rule',
    10: 'Allowed rule',
  };

  const rows = data.data?.viewer?.scope?.[0]?.data || [];

  return rows
    .map(item => ({
      metric: item.dimensions?.metric,
      label: RESOLVER_DECISION_LABELS[item.dimensions?.metric] || `Decision ${item.dimensions?.metric}`,
      count: item.count || 0,
    }))
    .sort((a, b) => b.count - a.count);
}

const TRAFFIC_MAP_COUNTRY_CENTROIDS = {
  VN: [16.0583, 108.2772], US: [37.0902, -95.7129], CN: [35.8617, 104.1954],
  JP: [36.2048, 138.2529], KR: [35.9078, 127.7669], IN: [20.5937, 78.9629],
  GB: [55.3781, -3.4360], DE: [51.1657, 10.4515], FR: [46.2276, 2.2137],
  AU: [-25.2744, 133.7751], CA: [56.1304, -106.3468], BR: [-14.2350, -51.9253],
  RU: [61.5240, 105.3188], SG: [1.3521, 103.8198], HK: [22.3193, 114.1694],
  TW: [23.6978, 120.9605], TH: [15.8700, 100.9925], ID: [-0.7893, 113.9213],
  MY: [4.2105, 101.9758], PH: [12.8797, 121.7740], NL: [52.1326, 5.2913],
  IE: [53.1424, -7.6921], IT: [41.8719, 12.5674], ES: [40.4637, -3.7492],
  IL: [31.0461, 34.8516], MX: [23.6345, -102.5528], AR: [-38.4161, -63.6167],
  CL: [-35.6751, -71.5430], ZA: [-30.5595, 22.9375], NG: [9.0820, 8.6753],
  EG: [26.8206, 30.8025], AE: [23.4241, 53.8478], SA: [23.8859, 45.0792],
  TR: [38.9637, 35.2433], PL: [51.9194, 19.1451], SE: [60.1282, 18.6435],
  NO: [60.4720, 8.4689], FI: [61.9241, 25.7482], DK: [56.2639, 9.5018],
  CH: [46.8182, 8.2275], BE: [50.5039, 4.4699], AT: [47.5162, 14.5501],
  PT: [39.3999, -8.2245], GR: [39.0742, 21.8243], CZ: [49.8175, 15.4730],
  UA: [48.3794, 31.1656], RO: [45.9432, 24.9668], NZ: [-40.9006, 174.8860],
};

function readPositiveIntegerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const TRAFFIC_MAP_HOURS = readPositiveIntegerEnv('TRAFFIC_MAP_HOURS', 24);
const TRAFFIC_MAP_ACTIVITY_LIMIT = readPositiveIntegerEnv('TRAFFIC_MAP_ACTIVITY_LIMIT', 5000);
const TRAFFIC_MAP_MAX_ACTIVITY_PAGES = readPositiveIntegerEnv('TRAFFIC_MAP_MAX_ACTIVITY_PAGES', 20);
const TRAFFIC_MAP_ACTIVITY_FIELDS = [
  'blocked',
  'datetime',
  'decision',
  'initial_resolved_ips',
  'query',
  'query_id',
  'resolved_ips',
  'source_ip',
  'src_country_code',
];

function normalizeCountryCode(value) {
  return String(value || '').trim().toUpperCase();
}

function getResolvedIpCandidates(log) {
  return [
    ...(Array.isArray(log.resolved_ips) ? log.resolved_ips : []),
    ...(Array.isArray(log.initial_resolved_ips) ? log.initial_resolved_ips : []),
  ].filter(ip => isIP(ip) !== 0);
}

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
      const insert = db.prepare(`
        INSERT OR IGNORE INTO logs (query_id, datetime, src_country, src_country_code, source_ip, resolved_ips)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      
      db.exec('BEGIN TRANSACTION');
      try {
        for (const log of fetchedLogs) {
          if (!log.query_id) continue;
          insert.run(
            log.query_id,
            log.datetime || null,
            log.src_country || null,
            log.src_country_code || null,
            log.source_ip || null,
            JSON.stringify(log.resolved_ips || [])
          );
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

// DNS Analytics Sync Functions
const DNS_ANALYTICS_RETENTION_DAYS = readPositiveIntegerEnv('DNS_ANALYTICS_RETENTION_DAYS', 30);

function get15MinBucketTs(timestampMs) {
  return Math.floor(timestampMs / (15 * 60 * 1000)) * (15 * 60);
}

async function syncDNSAnalyticsToDatabase(forceFull = false) {
  if (!ACCOUNT_ID || !API_TOKEN) {
    console.log('DNS analytics sync skipped: missing credentials');
    return;
  }
  
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  
  // Determine sync window
  let fromSec = nowSec - 24 * 60 * 60; // Default: last 24 hours
  
  if (!forceFull) {
    const stmt = db.prepare('SELECT last_synced_ts FROM sync_state WHERE key = ?');
    const row = stmt.get('dns_analytics');
    if (row?.last_synced_ts) {
      // Start from last sync, but go back 1 hour for overlap/safety
      fromSec = Math.max(row.last_synced_ts - 60 * 60, nowSec - 24 * 60 * 60);
    }
  }
  
  const startTime = new Date(fromSec * 1000).toISOString();
  const endTime = new Date(nowMs).toISOString();
  
  console.log(`Starting DNS analytics sync: ${startTime} to ${endTime}`);
  
  try {
    // Fetch time series data with 15-min buckets
    const timeSeriesQuery = `
      query GetDNSTimeSeries($accountTag: string!, $start: Time!, $end: Time!) {
        viewer {
          scope: accounts(filter: { accountTag: $accountTag }) {
            sparkline: gatewayResolverQueriesAdaptiveGroups(
              filter: { datetime_geq: $start, datetime_lt: $end }
              limit: 5000
              orderBy: [datetimeFifteenMinutes_ASC]
            ) {
              count
              dimensions {
                ts: datetimeFifteenMinutes
              }
            }
          }
        }
      }
    `;
    
    const topDomainsQuery = `
      query GetTopDomainsByTime($accountTag: string!, $start: Time!, $end: Time!, $limit: Int!) {
        viewer {
          scope: accounts(filter: { accountTag: $accountTag }) {
            data: gatewayResolverQueriesAdaptiveGroups(
              filter: { datetime_geq: $start, datetime_lt: $end }
              limit: $limit
              orderBy: [count_DESC]
            ) {
              count
              dimensions {
                ts: datetimeFifteenMinutes
                queryName
              }
            }
          }
        }
      }
    `;
    
    const topLocationsQuery = `
      query GetTopLocationsByTime($accountTag: string!, $start: Time!, $end: Time!, $limit: Int!) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            data: gatewayResolverQueriesAdaptiveGroups(
              filter: { datetime_geq: $start, datetime_lt: $end }
              limit: $limit
              orderBy: [count_DESC]
            ) {
              count
              dimensions {
                ts: datetimeFifteenMinutes
                locationName: coloName
              }
            }
          }
        }
      }
    `;
    
    const decisionsQuery = `
      query GetDecisionsByTime($accountTag: string!, $start: Time!, $end: Time!) {
        viewer {
          scope: accounts(filter: { accountTag: $accountTag }) {
            data: gatewayResolverQueriesAdaptiveGroups(
              filter: { datetime_geq: $start, datetime_lt: $end }
              limit: 100
              orderBy: [count_DESC]
            ) {
              count
              dimensions {
                ts: datetimeFifteenMinutes
                metric: resolverDecision
              }
            }
          }
        }
      }
    `;
    
    const variables = {
      accountTag: ACCOUNT_ID,
      start: startTime,
      end: endTime,
      limit: 100
    };
    
    // Fetch all data types in parallel
    const [timeSeriesRes, domainsRes, locationsRes, decisionsRes] = await Promise.all([
      fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_TOKEN}` },
        body: JSON.stringify({ query: timeSeriesQuery, variables })
      }).then(r => r.json()),
      fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_TOKEN}` },
        body: JSON.stringify({ query: topDomainsQuery, variables: { ...variables, limit: 100 } })
      }).then(r => r.json()),
      fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_TOKEN}` },
        body: JSON.stringify({ query: topLocationsQuery, variables: { ...variables, limit: 100 } })
      }).then(r => r.json()),
      fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_TOKEN}` },
        body: JSON.stringify({ query: decisionsQuery, variables })
      }).then(r => r.json())
    ]);
    
    // Process and store time series
    const tsData = timeSeriesRes.data?.viewer?.scope?.[0]?.sparkline || [];
    const domainsData = domainsRes.data?.viewer?.scope?.[0]?.data || [];
    const locationsData = locationsRes.data?.viewer?.accounts?.[0]?.data || [];
    const decisionsData = decisionsRes.data?.viewer?.scope?.[0]?.data || [];
    
    db.exec('BEGIN TRANSACTION');
    try {
      // Store time series buckets
      const insertTs = db.prepare('INSERT OR REPLACE INTO dns_timeseries (bucket_ts, count) VALUES (?, ?)');
      for (const item of tsData) {
        const ts = new Date(item.dimensions?.ts).getTime();
        if (!Number.isFinite(ts)) continue;
        const bucketTs = get15MinBucketTs(ts);
        insertTs.run(bucketTs, item.count || 0);
      }
      
      // Store top domains by bucket
      const insertDomain = db.prepare('INSERT OR REPLACE INTO dns_top_domains (bucket_ts, domain, count) VALUES (?, ?, ?)');
      for (const item of domainsData) {
        const ts = new Date(item.dimensions?.ts).getTime();
        if (!Number.isFinite(ts)) continue;
        const bucketTs = get15MinBucketTs(ts);
        insertDomain.run(bucketTs, item.dimensions?.queryName || 'N/A', item.count || 0);
      }
      
      // Store top locations by bucket
      const insertLocation = db.prepare('INSERT OR REPLACE INTO dns_top_locations (bucket_ts, location, count) VALUES (?, ?, ?)');
      for (const item of locationsData) {
        const ts = new Date(item.dimensions?.ts).getTime();
        if (!Number.isFinite(ts)) continue;
        const bucketTs = get15MinBucketTs(ts);
        insertLocation.run(bucketTs, item.dimensions?.locationName || 'Unknown', item.count || 0);
      }
      
      // Store resolver decisions by bucket
      const insertDecision = db.prepare('INSERT OR REPLACE INTO dns_resolver_decisions (bucket_ts, decision, count) VALUES (?, ?, ?)');
      for (const item of decisionsData) {
        const ts = new Date(item.dimensions?.ts).getTime();
        if (!Number.isFinite(ts)) continue;
        const bucketTs = get15MinBucketTs(ts);
        const decision = String(item.dimensions?.metric || '');
        insertDecision.run(bucketTs, decision, item.count || 0);
      }
      
      // Clean old data beyond retention
      const retentionCutoff = nowSec - DNS_ANALYTICS_RETENTION_DAYS * 24 * 60 * 60;
      db.prepare('DELETE FROM dns_timeseries WHERE bucket_ts < ?').run(retentionCutoff);
      db.prepare('DELETE FROM dns_top_domains WHERE bucket_ts < ?').run(retentionCutoff);
      db.prepare('DELETE FROM dns_top_locations WHERE bucket_ts < ?').run(retentionCutoff);
      db.prepare('DELETE FROM dns_resolver_decisions WHERE bucket_ts < ?').run(retentionCutoff);
      
      // Update sync state
      const updateSync = db.prepare(`
        INSERT INTO sync_state (key, last_synced_ts, oldest_synced_ts) 
        VALUES ('dns_analytics', ?, COALESCE((SELECT oldest_synced_ts FROM sync_state WHERE key='dns_analytics'), ?))
        ON CONFLICT(key) DO UPDATE SET last_synced_ts = excluded.last_synced_ts
      `);
      updateSync.run(nowSec, fromSec);
      
      db.exec('COMMIT');
      
      const totalCount = db.prepare('SELECT SUM(count) as total FROM dns_timeseries WHERE bucket_ts >= ?').get(retentionCutoff).total || 0;
      console.log(`DNS analytics sync complete. Buckets: ${tsData.length}, Total queries in DB: ${totalCount}`);
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } catch (err) {
    console.error('DNS analytics sync failed:', err.message);
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

async function buildTrafficMapData(range = '24h') {
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

// Socket Communication
io.on('connection', (socket) => {
  socket.on('run_update', async () => {
    console.log("run_update event received!");
    try {
      await runScript(["download_lists.js"], socket);
      await runScript(["cf_list_create.js"], socket);
      await runScript(["cf_gateway_rule_create.js"], socket);
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
      const DOMAIN_RE = /^([a-z0-9-]+\.)+[a-z]{2,}$/;
      const validDomains = [];
      const invalidDomains = [];

      for (const d of domains) {
        if (DOMAIN_RE.test(d)) {
          validDomains.push(d);
        } else {
          invalidDomains.push(d);
        }
      }

      if (invalidDomains.length > 0) {
        socket.emit('log', `\x1b[33mSkipping ${invalidDomains.length} invalid domain(s): ${invalidDomains.join(', ')}\x1b[0m\n`);
      }

      if (validDomains.length === 0) {
        socket.emit('log', `\x1b[31mNo valid domains to process.\x1b[0m\n`);
        return;
      }

      let finalDomains = validDomains;

      if (action === 'remove') {
        socket.emit('log', `\x1b[34mChecking domains in list...\x1b[0m\n`);
        const existingItems = await fetchCustomListItems(listId);
        const existingSet = new Set(existingItems);
        finalDomains = validDomains.filter(d => existingSet.has(d));
        
        if (finalDomains.length === 0) {
          socket.emit('log', `\x1b[33mNone of the valid domains were found in the list. Skipping remove.\x1b[0m\n`);
          return;
        }

        if (finalDomains.length < validDomains.length) {
          socket.emit('log', `\x1b[33mSkipping ${validDomains.length - finalDomains.length} domains not found in list.\x1b[0m\n`);
        }
      }

      socket.emit('log', `\x1b[34mProcessing ${action} for ${finalDomains.length} domain(s)...\x1b[0m\n`);
      const patchData = action === 'add' 
        ? { append: finalDomains.map(d => ({ value: d })) }
        : { remove: finalDomains };

      const patchResult = await requestGateway(`/lists/${listId}`, {
        method: "PATCH",
        body: JSON.stringify(patchData),
      });

      if (patchResult?.success === false) throw new Error(JSON.stringify(patchResult.errors));
      
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
      const DOMAIN_RE = /^([a-z0-9-]+\.)+[a-z]{2,}$/;
      const validDomains = [];
      const invalidDomains = [];

      for (const d of domains) {
        if (DOMAIN_RE.test(d)) {
          validDomains.push(d);
        } else {
          invalidDomains.push(d);
        }
      }

      if (invalidDomains.length > 0) {
        socket.emit('log', `\x1b[33mSkipping ${invalidDomains.length} invalid domain(s): ${invalidDomains.join(', ')}\x1b[0m\n`);
      }

      if (validDomains.length === 0) {
        socket.emit('log', `\x1b[31mNo valid domains to process.\x1b[0m\n`);
        return;
      }

      let finalDomains = validDomains;

      if (action === 'remove') {
        socket.emit('log', `\x1b[34mChecking domains in list...\x1b[0m\n`);
        const existingItems = await fetchCustomListItems(listId);
        const existingSet = new Set(existingItems);
        finalDomains = validDomains.filter(d => existingSet.has(d));
        
        if (finalDomains.length === 0) {
          socket.emit('log', `\x1b[33mNone of the valid domains were found in the list. Skipping remove.\x1b[0m\n`);
          return;
        }

        if (finalDomains.length < validDomains.length) {
          socket.emit('log', `\x1b[33mSkipping ${validDomains.length - finalDomains.length} domains not found in list.\x1b[0m\n`);
        }
      }

      socket.emit('log', `\x1b[34mProcessing ${action} for ${finalDomains.length} domain(s)...\x1b[0m\n`);
      const patchData = action === 'add' 
        ? { append: finalDomains.map(d => ({ value: d })) }
        : { remove: finalDomains };

      const patchResult = await requestGateway(`/lists/${listId}`, {
        method: "PATCH",
        body: JSON.stringify(patchData),
      });

      if (patchResult?.success === false) throw new Error(JSON.stringify(patchResult.errors));
      
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
      
      // 1. Emit cached data immediately
      const cachedData = await buildTrafficMapData(range);
      const syncState = db.prepare('SELECT last_synced_ts FROM sync_state WHERE key = ?').get('traffic_map');
      const cachedAt = syncState?.last_synced_ts ? new Date(syncState.last_synced_ts * 1000).toISOString() : null;
      
      socket.emit('traffic_map_data', {
        success: true,
        ...cachedData,
        range,
        source: 'cache',
        cachedAt,
      });
      
      // 2. If forced, trigger a sync and emit fresh data
      if (force) {
        await syncTrafficLogsToDatabase(false);
        const freshData = await buildTrafficMapData(range);
        socket.emit('traffic_map_data', {
          success: true,
          ...freshData,
          range,
          source: 'live',
          cachedAt: new Date().toISOString(),
        });
      }
    } catch (e) {
      console.error('Traffic map error:', e);
      socket.emit('traffic_map_data', { success: false, error: e.message, range: options?.range || '24h' });
    }
  });
});

const PORT = process.env.PORT || 3333;
const HOST = process.env.HOST || (existsSync("/.dockerenv") ? "0.0.0.0" : "127.0.0.1");

if (!DASHBOARD_PASSWORD && !DASHBOARD_AUTH_DISABLED) {
  console.warn("Dashboard remote access is blocked until DASHBOARD_PASSWORD is set.");
}

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
