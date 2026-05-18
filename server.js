import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { fileURLToPath } from 'url';
import geoip from 'geoip-lite';
import { DatabaseSync } from 'node:sqlite';
import { getEnvPath } from './lib/env.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ENV_PATH = getEnvPath();

// Import constants for DNS analytics and dynamic Cloudflare Gateway API requests.
import {
  getZeroTrustLists,
  getZeroTrustRules,
  deleteZeroTrustListsOneByOne,
  deleteZeroTrustRule,
} from './lib/api.js';
import { requestGateway } from './lib/helpers.js';
import { 
  ACCOUNT_ID,
  API_TOKEN,
  RECOMMENDED_ALLOWLIST_URLS, 
  RECOMMENDED_BLOCKLIST_URLS 
} from './lib/constants.js';

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
const socketViewState = new Map();

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
const GATEWAY_LOCATION_ID = process.env.CLOUDFLARE_GATEWAY_LOCATION_ID || "97434c6e90c046e9b6def9da8cb08a40";
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
      cwd: __dirname,
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
  const { result } = await requestGateway(`/lists/${listId}/items?per_page=1000`, { method: "GET" });
  return (result ?? []).map((item) => item.value);
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

function getPrimaryIpv4Network(location) {
  return Array.isArray(location?.networks) && location.networks.length > 0
    ? location.networks[0]?.network || ""
    : "";
}

function getDnsEndpointValue(enabled, value) {
  return {
    enabled: enabled !== false && Boolean(value),
    value: value || "",
  };
}

function pickEndpointFields(endpoint = {}, allowedFields = []) {
  const picked = {};
  for (const field of allowedFields) {
    if (endpoint[field] !== undefined) picked[field] = endpoint[field];
  }
  return picked;
}

function buildGatewayLocationUpdatePayload(location, network) {
  const endpoints = location.endpoints || {};
  const payload = {
    name: location.name,
    networks: [{ network }],
  };

  if (location.client_default !== undefined) payload.client_default = location.client_default;
  if (location.dns_destination_ips_id !== undefined) payload.dns_destination_ips_id = location.dns_destination_ips_id;
  if (location.ecs_support !== undefined) payload.ecs_support = location.ecs_support;
  if (location.dns_destination_ipv6_block_id) {
    payload.dns_destination_ipv6_block_id = location.dns_destination_ipv6_block_id;
  }

  const sanitizedEndpoints = {};
  if (endpoints.doh) sanitizedEndpoints.doh = pickEndpointFields(endpoints.doh, ["enabled", "networks", "require_token"]);
  if (endpoints.dot) sanitizedEndpoints.dot = pickEndpointFields(endpoints.dot, ["enabled", "networks"]);
  if (endpoints.ipv4) sanitizedEndpoints.ipv4 = pickEndpointFields(endpoints.ipv4, ["enabled"]);
  if (endpoints.ipv6) sanitizedEndpoints.ipv6 = pickEndpointFields(endpoints.ipv6, ["enabled", "networks"]);
  if (Object.keys(sanitizedEndpoints).length > 0) payload.endpoints = sanitizedEndpoints;

  return payload;
}

function serializeGatewayLocationIpv4(location) {
  const protectedNetwork = getPrimaryIpv4Network(location);
  const ipv4Pair = [location.ipv4_destination, location.ipv4_destination_backup]
    .filter(Boolean)
    .join(" / ");
  const gatewayHostname = location.doh_subdomain
    ? `${location.doh_subdomain}.cloudflare-gateway.com`
    : "";

  return {
    locationName: location.name || "Cloudflare location",
    protectedNetwork,
    network: protectedNetwork,
    dnsEndpoints: {
      ipv4: getDnsEndpointValue(location.endpoints?.ipv4?.enabled, ipv4Pair),
      ipv6: getDnsEndpointValue(location.endpoints?.ipv6?.enabled, location.ip),
      dot: getDnsEndpointValue(location.endpoints?.dot?.enabled, gatewayHostname),
      doh: getDnsEndpointValue(location.endpoints?.doh?.enabled, gatewayHostname ? `https://${gatewayHostname}/dns-query` : ""),
    },
    updatedAt: location.updated_at || null,
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
  AD: [42.5462, 1.6016], AE: [23.4241, 53.8478], AF: [33.9391, 67.7100],
  AG: [17.0608, -61.7964], AL: [41.1533, 20.1683], AM: [40.0691, 45.0382],
  AO: [-11.2027, 17.8739], AR: [-38.4161, -63.6167], AT: [47.5162, 14.5501],
  AU: [-25.2744, 133.7751], AZ: [40.1431, 47.5769], BA: [43.9159, 17.6791],
  BB: [13.1939, -59.5432], BD: [23.6850, 90.3563], BE: [50.5039, 4.4699],
  BF: [12.2383, -1.5616], BG: [42.7339, 25.4858], BH: [25.9304, 50.6378],
  BI: [-3.3731, 29.9189], BJ: [9.3077, 2.3158], BN: [4.5353, 114.7277],
  BO: [-16.2902, -63.5887], BR: [-14.2350, -51.9253], BS: [25.0343, -77.3963],
  BT: [27.5142, 90.4336], BW: [-22.3285, 24.6849], BY: [53.7098, 27.9534],
  BZ: [17.1899, -88.4976], CA: [56.1304, -106.3468], CD: [-4.0383, 21.7587],
  CF: [6.6111, 20.9394], CG: [-0.2280, 15.8277], CH: [46.8182, 8.2275],
  CI: [7.5400, -5.5471], CL: [-35.6751, -71.5430], CM: [7.3697, 12.3547],
  CN: [35.8617, 104.1954], CO: [4.5709, -74.2973], CR: [9.7489, -83.7534],
  CU: [21.5218, -77.7812], CV: [16.5388, -23.0418], CY: [35.1264, 33.4299],
  CZ: [49.8175, 15.4730], DE: [51.1657, 10.4515], DJ: [11.8251, 42.5903],
  DK: [56.2639, 9.5018], DM: [15.4150, -61.3710], DO: [18.7357, -70.1627],
  DZ: [28.0339, 1.6596], EC: [-1.8312, -78.1834], EE: [58.5953, 25.0136],
  EG: [26.8206, 30.8025], ER: [15.1794, 39.7823], ES: [40.4637, -3.7492],
  ET: [9.1450, 40.4897], FI: [61.9241, 25.7482], FJ: [-16.5780, 179.4144],
  FM: [7.4256, 150.5508], FR: [46.2276, 2.2137], GA: [-0.8037, 11.6094],
  GB: [55.3781, -3.4360], GD: [12.1165, -61.6790], GE: [42.3154, 43.3569],
  GH: [7.9465, -1.0232], GM: [13.4432, -15.3101], GN: [9.9456, -9.6966],
  GQ: [1.6508, 10.2679], GR: [39.0742, 21.8243], GT: [15.7835, -90.2308],
  GW: [11.8037, -15.1801], GY: [4.8604, -58.9302], HK: [22.3193, 114.1694],
  HN: [15.2000, -86.2419], HR: [45.1000, 15.2000], HT: [18.9712, -72.2852],
  HU: [47.1625, 19.5033], ID: [-0.7893, 113.9213], IE: [53.1424, -7.6921],
  IL: [31.0461, 34.8516], IN: [20.5937, 78.9629], IQ: [33.2232, 43.6793],
  IR: [32.4279, 53.6880], IS: [64.9631, -19.0208], IT: [41.8719, 12.5674],
  JM: [18.1096, -77.2975], JO: [30.5852, 36.2384], JP: [36.2048, 138.2529],
  KE: [-0.0236, 37.9062], KG: [41.2044, 74.7661], KH: [12.5657, 104.9910],
  KI: [-3.3704, -168.7340], KM: [-11.6455, 43.3333], KN: [17.3578, -62.7830],
  KP: [40.3399, 127.5101], KR: [35.9078, 127.7669], KW: [29.3117, 47.4818],
  KZ: [48.0196, 66.9237], LA: [19.8563, 102.4955], LB: [33.8547, 35.8623],
  LC: [13.9094, -60.9789], LI: [47.1660, 9.5554], LK: [7.8731, 80.7718],
  LR: [6.4281, -9.4295], LS: [-29.6100, 28.2336], LT: [55.1694, 23.8813],
  LU: [49.8153, 6.1296], LV: [56.8796, 24.6032], LY: [26.3351, 17.2283],
  MA: [31.7917, -7.0926], MC: [43.7384, 7.4246], MD: [47.4116, 28.3699],
  ME: [42.7087, 19.3744], MG: [-18.7669, 46.8691], MH: [7.1315, 171.1845],
  MK: [41.6086, 21.7453], ML: [17.5707, -3.9962], MM: [21.9162, 95.9560],
  MN: [46.8625, 103.8467], MO: [22.1987, 113.5439], MR: [21.0079, -10.9408],
  MT: [35.9375, 14.3754], MU: [-20.3484, 57.5522], MV: [3.2028, 73.2207],
  MW: [-13.2543, 34.3015], MX: [23.6345, -102.5528], MY: [4.2105, 101.9758],
  MZ: [-18.6657, 35.5296], NA: [-22.9576, 18.4904], NE: [17.6078, 8.0817],
  NG: [9.0820, 8.6753], NI: [12.8654, -85.2072], NL: [52.1326, 5.2913],
  NO: [60.4720, 8.4689], NP: [28.3949, 84.1240], NR: [-0.5228, 166.9315],
  NZ: [-40.9006, 174.8860], OM: [21.4735, 55.9754], PA: [8.5380, -80.7821],
  PE: [-9.1900, -75.0152], PG: [-6.3149, 143.9555], PH: [12.8797, 121.7740],
  PK: [30.3753, 69.3451], PL: [51.9194, 19.1451], PT: [39.3999, -8.2245],
  PW: [7.5150, 134.5825], PY: [-23.4425, -58.4438], QA: [25.3548, 51.1839],
  RO: [45.9432, 24.9668], RS: [44.0165, 21.0059], RU: [61.5240, 105.3188],
  RW: [-1.9403, 29.8739], SA: [23.8859, 45.0792], SB: [-9.6457, 160.1562],
  SC: [-4.6796, 55.4920], SD: [12.8628, 30.2176], SE: [60.1282, 18.6435],
  SG: [1.3521, 103.8198], SI: [46.1512, 14.9955], SK: [48.6690, 19.6990],
  SL: [8.4606, -11.7799], SM: [43.9424, 12.4578], SN: [14.4974, -14.4524],
  SO: [5.1521, 46.1996], SR: [3.9193, -56.0278], SS: [6.8770, 31.3070],
  ST: [0.1864, 6.6131], SV: [13.7942, -88.8965], SY: [34.8021, 38.9968],
  SZ: [-26.5225, 31.4659], TD: [15.4542, 18.7322], TG: [8.6195, 0.8248],
  TH: [15.8700, 100.9925], TJ: [38.8610, 71.2761], TL: [-8.8742, 125.7275],
  TM: [38.9697, 59.5563], TN: [33.8869, 9.5375], TO: [-21.1789, -175.1982],
  TR: [38.9637, 35.2433], TT: [10.6918, -61.2225], TV: [-7.1095, 177.6493],
  TW: [23.6978, 120.9605], TZ: [-6.3690, 34.8888], UA: [48.3794, 31.1656],
  UG: [1.3733, 32.2903], US: [37.0902, -95.7129], UY: [-32.5228, -55.7658],
  UZ: [41.3775, 64.5853], VA: [41.9029, 12.4534], VC: [12.9843, -61.2872],
  VE: [6.4238, -66.5897], VN: [16.0583, 108.2772], VU: [-15.3767, 166.9592],
  WS: [-13.7590, -172.1046], XK: [42.6026, 20.9030], YE: [15.5527, 48.5164],
  ZA: [-30.5595, 22.9375], ZM: [-13.1339, 27.8493], ZW: [-19.0154, 29.1549],
  AI: [18.2206, -63.0686], AQ: [-82.8628, 135.0000], AS: [-14.2710, -170.1322],
  AW: [12.5211, -69.9683], AX: [60.1785, 19.9156], BL: [17.9000, -62.8333],
  BM: [32.3078, -64.7505], BQ: [12.1784, -68.2385], BV: [-54.4208, 3.3464],
  CC: [-12.1642, 96.8710], CK: [-21.2367, -159.7777], CW: [12.1696, -68.9900],
  CX: [-10.4475, 105.6904], EH: [24.2155, -12.8858], FK: [-51.7963, -59.5236],
  FO: [61.8926, -6.9118], GF: [3.9339, -53.1258], GG: [49.4657, -2.5853],
  GI: [36.1408, -5.3536], GL: [71.7069, -42.6043], GP: [16.9950, -62.0673],
  GS: [-54.4296, -36.5879], GU: [13.4443, 144.7937], HM: [-53.0818, 73.5042],
  IM: [54.2361, -4.5481], IO: [-6.3432, 71.8765], JE: [49.2144, -2.1313],
  KY: [19.3133, -81.2546], MF: [18.0708, -63.0501], MP: [17.3308, 145.3846],
  MQ: [14.6415, -61.0242], MS: [16.7425, -62.1874], NC: [-20.9043, 165.6180],
  NF: [-29.0408, 167.9547], NU: [-19.0544, -169.8672], PF: [-17.6797, -149.4068],
  PM: [46.9419, -56.2711], PN: [-24.7036, -127.4393], PR: [18.2208, -66.5901],
  PS: [31.9522, 35.2332], RE: [-21.1151, 55.5364], SH: [-24.1437, -10.0307],
  SJ: [77.5536, 23.6703], SX: [18.0425, -63.0548], TC: [21.6940, -71.7979],
  TF: [-49.2804, 69.3486], TK: [-8.9676, -171.8559], UM: [19.2823, 166.6470],
  VG: [18.4207, -64.6400], VI: [18.3358, -64.8963], WF: [-13.7687, -177.1561],
  YT: [-12.8275, 45.1662], AC: [-7.9467, -14.3559], CP: [10.2833, -109.2167],
  DG: [-7.3133, 72.4111], EA: [35.8894, -5.3213], IC: [28.2916, -16.6291],
  TA: [-37.1052, -12.2777], UK: [55.3781, -3.4360], AN: [12.2261, -69.0600],
  CS: [44.0165, 21.0059], YU: [44.0165, 21.0059], SU: [61.5240, 105.3188],
  TP: [-8.8742, 125.7275], ZR: [-4.0383, 21.7587], BU: [21.9162, 95.9560],
  EU: [50.0000, 10.0000], AP: [10.0000, 120.0000], T1: [-38.0000, -25.0000],
  A1: [-40.0000, -20.0000], A2: [-42.0000, -15.0000], O1: [-44.0000, -10.0000],
  XX: [-46.0000, -5.0000],
};

function readPositiveIntegerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const TRAFFIC_MAP_HOURS = readPositiveIntegerEnv('TRAFFIC_MAP_HOURS', 24);
const TRAFFIC_MAP_GRAPHQL_HOURS = Math.min(TRAFFIC_MAP_HOURS, 24);
const TRAFFIC_MAP_ROW_LIMIT = readPositiveIntegerEnv('TRAFFIC_MAP_ROW_LIMIT', 10000);
const TRAFFIC_MAP_SYNC_COOLDOWN_SECONDS = readPositiveIntegerEnv('TRAFFIC_MAP_SYNC_COOLDOWN_SECONDS', 300);
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

const TRAFFIC_MAP_GRAPHQL_QUERY = `
query TrafficMap($acct: string!, $start: Time!, $end: Time!, $rowLimit: Int!) {
  viewer {
    accounts(filter: { accountTag: $acct }) {
      total: gatewayResolverQueriesAdaptiveGroups(
        filter: { datetime_geq: $start, datetime_leq: $end }
        limit: 1
      ) { count }
      sources: gatewayResolverQueriesAdaptiveGroups(
        filter: { datetime_geq: $start, datetime_leq: $end }
        limit: $rowLimit
        orderBy: [count_DESC]
      ) { count dimensions { srcIpCountry } }
      destinations: gatewayResolverQueriesAdaptiveGroups(
        filter: { datetime_geq: $start, datetime_leq: $end }
        limit: $rowLimit
        orderBy: [count_DESC]
      ) { count dimensions { resolvedIpCountries } }
      routes: gatewayResolverQueriesAdaptiveGroups(
        filter: { datetime_geq: $start, datetime_leq: $end }
        limit: $rowLimit
        orderBy: [count_DESC]
      ) { count dimensions { srcIpCountry resolvedIpCountries } }
    }
  }
}`;

function uniqueTrafficMapCountries(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  for (const value of list) {
    const country = normalizeCountryCode(value);
    if (country) seen.add(country);
  }
  return [...seen];
}

async function fetchTrafficMapGraphQLAggregate() {
  if (!ACCOUNT_ID || !API_TOKEN) {
    throw new Error('Traffic map GraphQL sync skipped: missing ACCOUNT_ID or API_TOKEN');
  }

  const end = new Date();
  const start = new Date(end.getTime() - TRAFFIC_MAP_GRAPHQL_HOURS * 60 * 60 * 1000);
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_TOKEN}`,
    },
    body: JSON.stringify({
      query: TRAFFIC_MAP_GRAPHQL_QUERY,
      variables: {
        acct: ACCOUNT_ID,
        start: start.toISOString(),
        end: end.toISOString(),
        rowLimit: TRAFFIC_MAP_ROW_LIMIT,
      },
    }),
  });
  const data = await response.json();

  if (!response.ok || data.errors) {
    throw new Error(`Traffic map GraphQL error: ${JSON.stringify(data.errors || data)}`);
  }

  const account = data.data?.viewer?.accounts?.[0];
  if (!account) throw new Error('Traffic map GraphQL error: no account node returned');

  return {
    totalQueries: account.total?.[0]?.count || 0,
    rawSources: account.sources || [],
    rawDestinations: account.destinations || [],
    rawRoutes: account.routes || [],
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
  };
}

function aggregateTrafficMapGraphQLRows(raw) {
  const sources = new Map();
  const destinations = new Map();
  const routes = new Map();
  const unmapped = new Map();
  const noteUnmapped = country => {
    if (country) unmapped.set(country, (unmapped.get(country) || 0) + 1);
  };

  for (const row of raw.rawSources) {
    const country = normalizeCountryCode(row.dimensions?.srcIpCountry);
    if (!country) continue;
    const point = countryPoint(country);
    if (point.lat == null || point.lng == null) {
      noteUnmapped(country);
      continue;
    }
    sources.set(country, (sources.get(country) || 0) + (row.count || 0));
  }

  for (const row of raw.rawDestinations) {
    const countries = uniqueTrafficMapCountries(row.dimensions?.resolvedIpCountries);
    for (const country of countries) {
      const point = countryPoint(country);
      if (point.lat == null || point.lng == null) {
        noteUnmapped(country);
        continue;
      }
      destinations.set(country, (destinations.get(country) || 0) + (row.count || 0));
    }
  }

  for (const row of raw.rawRoutes) {
    const sourceCountry = normalizeCountryCode(row.dimensions?.srcIpCountry);
    const destinationCountries = uniqueTrafficMapCountries(row.dimensions?.resolvedIpCountries);
    if (!sourceCountry || destinationCountries.length === 0) continue;
    const sourcePoint = countryPoint(sourceCountry);
    if (sourcePoint.lat == null || sourcePoint.lng == null) {
      noteUnmapped(sourceCountry);
      continue;
    }

    for (const destinationCountry of destinationCountries) {
      if (destinationCountry === sourceCountry) continue;
      const destinationPoint = countryPoint(destinationCountry);
      if (destinationPoint.lat == null || destinationPoint.lng == null) {
        noteUnmapped(destinationCountry);
        continue;
      }
      const key = `${sourceCountry}->${destinationCountry}`;
      const current = routes.get(key);
      if (current) {
        current.count += row.count || 0;
      } else {
        routes.set(key, {
          sourceCountry,
          sourceLat: sourcePoint.lat,
          sourceLng: sourcePoint.lng,
          destinationCountry,
          destinationLat: destinationPoint.lat,
          destinationLng: destinationPoint.lng,
          count: row.count || 0,
        });
      }
    }
  }

  return {
    sources: [...sources.entries()].map(([country, count]) => {
      const point = countryPoint(country);
      return { country, lat: point.lat, lng: point.lng, count };
    }).sort((a, b) => b.count - a.count),
    destinations: [...destinations.entries()].map(([country, count]) => {
      const point = countryPoint(country);
      return { country, lat: point.lat, lng: point.lng, count };
    }).sort((a, b) => b.count - a.count),
    routes: [...routes.values()].sort((a, b) => b.count - a.count),
    unmappedCountries: [...unmapped.entries()].sort((a, b) => b[1] - a[1]).map(([country, hits]) => ({ country, hits })),
  };
}

function writeTrafficMapAggregate(agg, summary) {
  db.exec('BEGIN TRANSACTION');
  try {
    db.exec('DELETE FROM traffic_map_sources; DELETE FROM traffic_map_destinations; DELETE FROM traffic_map_routes;');
    const insertSource = db.prepare('INSERT INTO traffic_map_sources (country, lat, lng, count) VALUES (?, ?, ?, ?)');
    const insertDestination = db.prepare('INSERT INTO traffic_map_destinations (country, lat, lng, count) VALUES (?, ?, ?, ?)');
    const insertRoute = db.prepare(`
      INSERT INTO traffic_map_routes
        (source_country, destination_country, source_lat, source_lng, destination_lat, destination_lng, count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const source of agg.sources) insertSource.run(source.country, source.lat, source.lng, source.count);
    for (const destination of agg.destinations) insertDestination.run(destination.country, destination.lat, destination.lng, destination.count);
    for (const route of agg.routes) {
      insertRoute.run(
        route.sourceCountry,
        route.destinationCountry,
        route.sourceLat,
        route.sourceLng,
        route.destinationLat,
        route.destinationLng,
        route.count
      );
    }
    db.prepare(`
      INSERT INTO traffic_map_meta (key, value) VALUES ('last_refresh', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify(summary));
    db.prepare(`
      INSERT INTO sync_state (key, last_synced_ts, oldest_synced_ts)
      VALUES ('traffic_map_graphql', ?, ?)
      ON CONFLICT(key) DO UPDATE SET last_synced_ts = excluded.last_synced_ts, oldest_synced_ts = excluded.oldest_synced_ts
    `).run(Math.floor(Date.now() / 1000), Math.floor(new Date(summary.window.from).getTime() / 1000));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function upsertTrafficMapDailySnapshot(agg, totalQueries) {
  const nowSec = Math.floor(Date.now() / 1000);
  const day = new Date().toISOString().slice(0, 10);
  const payload = JSON.stringify({
    sources: agg.sources,
    destinations: agg.destinations,
    routes: agg.routes,
  });
  db.prepare(`
    INSERT INTO traffic_map_daily_snapshots
      (day, total_queries, source_count, destination_count, route_count, payload, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET
      total_queries = excluded.total_queries,
      source_count = excluded.source_count,
      destination_count = excluded.destination_count,
      route_count = excluded.route_count,
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `).run(day, totalQueries, agg.sources.length, agg.destinations.length, agg.routes.length, payload, nowSec);
  db.prepare("DELETE FROM traffic_map_daily_snapshots WHERE day < date('now', '-30 days')").run();
}

let isTrafficMapGraphQLSyncing = false;
function isTrafficMapGraphQLSyncFresh() {
  const syncState = db.prepare('SELECT last_synced_ts FROM sync_state WHERE key = ?').get('traffic_map_graphql');
  if (!syncState?.last_synced_ts) return false;
  const ageSeconds = Math.floor(Date.now() / 1000) - syncState.last_synced_ts;
  return ageSeconds >= 0 && ageSeconds < TRAFFIC_MAP_SYNC_COOLDOWN_SECONDS;
}

async function syncTrafficMapAggregatesToDatabase() {
  if (isTrafficMapGraphQLSyncing) return;
  isTrafficMapGraphQLSyncing = true;
  try {
    const start = Date.now();
    const raw = await fetchTrafficMapGraphQLAggregate();
    const aggregate = aggregateTrafficMapGraphQLRows(raw);
    const summary = {
      totalQueries: raw.totalQueries,
      sources: aggregate.sources.length,
      destinations: aggregate.destinations.length,
      routes: aggregate.routes.length,
      unmappedCountries: aggregate.unmappedCountries,
      window: { from: raw.windowStart, to: raw.windowEnd },
      durationMs: Date.now() - start,
      updatedAt: new Date().toISOString(),
    };
    writeTrafficMapAggregate(aggregate, summary);
    upsertTrafficMapDailySnapshot(aggregate, raw.totalQueries);
    console.log(`Traffic map GraphQL sync complete. Total queries: ${raw.totalQueries}, sources: ${aggregate.sources.length}, destinations: ${aggregate.destinations.length}, routes: ${aggregate.routes.length}`);
  } catch (err) {
    console.error('Traffic map GraphQL sync failed:', err);
    throw err;
  } finally {
    isTrafficMapGraphQLSyncing = false;
  }
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

function buildDNSAnalyticsDataFromCache(range = '24h') {
  const cutoffSec = getCutoffForRange(range);
  const hasData = db.prepare('SELECT 1 FROM dns_timeseries WHERE bucket_ts >= ? LIMIT 1').get(cutoffSec);
  if (!hasData) return null;
  const syncState = db.prepare('SELECT last_synced_ts FROM sync_state WHERE key = ?').get('dns_analytics');
  const cachedAt = syncState?.last_synced_ts ? new Date(syncState.last_synced_ts * 1000).toISOString() : null;
  let bucketIntervalSec;
  switch (range) {
    case '7d': bucketIntervalSec = 60 * 60; break;
    case '30d': bucketIntervalSec = 6 * 60 * 60; break;
    case '24h':
    default: bucketIntervalSec = 15 * 60; break;
  }
  const tsRows = db.prepare(`
    SELECT 
      (bucket_ts / ?) * ? as aggregated_bucket,
      SUM(count) as count
    FROM dns_timeseries
    WHERE bucket_ts >= ?
    GROUP BY aggregated_bucket
    ORDER BY aggregated_bucket ASC
  `).all(bucketIntervalSec, bucketIntervalSec, cutoffSec);
  const timeSeries = tsRows.map(row => ({
    time: new Date(row.aggregated_bucket * 1000).toISOString(),
    count: row.count
  }));
  const topDomains = db.prepare(`
    SELECT domain, SUM(count) as total
    FROM dns_top_domains
    WHERE bucket_ts >= ?
    GROUP BY domain
    ORDER BY total DESC
    LIMIT 10
  `).all(cutoffSec).map(r => ({ domain: r.domain, count: r.total }));
  const topLocations = db.prepare(`
    SELECT location, SUM(count) as total
    FROM dns_top_locations
    WHERE bucket_ts >= ?
    GROUP BY location
    ORDER BY total DESC
    LIMIT 10
  `).all(cutoffSec).map(r => ({ location: r.location, count: r.total }));
  const RESOLVER_DECISION_LABELS = {
    '5': 'Allowed on no policy match',
    '9': 'Blocked rule',
    '10': 'Allowed rule',
  };
  const resolverDecisions = db.prepare(`
    SELECT decision, SUM(count) as total
    FROM dns_resolver_decisions
    WHERE bucket_ts >= ?
    GROUP BY decision
    ORDER BY total DESC
  `).all(cutoffSec).map(r => ({
    metric: r.decision,
    label: RESOLVER_DECISION_LABELS[r.decision] || `Decision ${r.decision}`,
    count: r.total
  }));
  return {
    timeSeries,
    totalCount: timeSeries.reduce((sum, item) => sum + (item.count || 0), 0),
    topDomains,
    topLocations,
    resolverDecisions,
    cachedAt,
  };
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

function readTrafficMapLastRefresh() {
  const row = db.prepare("SELECT value FROM traffic_map_meta WHERE key = 'last_refresh'").get();
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

function mergeTrafficMapItems(map, item) {
  const current = map.get(item.country);
  if (current) {
    current.count += item.count || 0;
  } else {
    map.set(item.country, { ...item, count: item.count || 0 });
  }
}

function mergeTrafficMapRoute(map, route) {
  if (!route.sourceCountry || !route.destinationCountry) return;
  const key = `${route.sourceCountry}->${route.destinationCountry}`;
  const current = map.get(key);
  if (current) {
    current.count += route.count || 0;
  } else {
    map.set(key, { ...route, count: route.count || 0 });
  }
}

function readTrafficMapDailyHistory() {
  return db.prepare(`
    SELECT day, total_queries, source_count, destination_count, route_count
    FROM traffic_map_daily_snapshots
    WHERE day >= date('now', '-30 days')
    ORDER BY day ASC
  `).all().map(row => ({
    day: row.day,
    totalQueries: row.total_queries,
    sourceCount: row.source_count,
    destinationCount: row.destination_count,
    routeCount: row.route_count,
  }));
}

function buildTrafficMapDataFromAggregateTables() {
  const sources = db.prepare('SELECT country, lat, lng, count FROM traffic_map_sources ORDER BY count DESC').all();
  const destinations = db.prepare('SELECT country, lat, lng, count FROM traffic_map_destinations ORDER BY count DESC').all();
  const routes = db.prepare(`
    SELECT source_country, destination_country, source_lat, source_lng, destination_lat, destination_lng, count
    FROM traffic_map_routes
    ORDER BY count DESC
  `).all().map(row => ({
    sourceCountry: row.source_country,
    sourceLat: row.source_lat,
    sourceLng: row.source_lng,
    destinationCountry: row.destination_country,
    destinationLat: row.destination_lat,
    destinationLng: row.destination_lng,
    count: row.count,
  }));
  const lastRefresh = readTrafficMapLastRefresh();

  if (sources.length === 0 && destinations.length === 0 && routes.length === 0) return null;

  return {
    sources,
    destinations,
    routes,
    totalQueries: sources.reduce((sum, source) => sum + (source.count || 0), 0),
    dailyHistory: readTrafficMapDailyHistory(),
    lastRefresh,
    dataRange: lastRefresh?.window ? { oldest: lastRefresh.window.from, latest: lastRefresh.window.to } : null,
    logsCount: sources.reduce((sum, source) => sum + (source.count || 0), 0),
    updatedAt: Date.now(),
  };
}

function buildTrafficMapDataFromDailySnapshots(range = '7d') {
  const days = range === '30d' ? 30 : 7;
  const rows = db.prepare(`
    SELECT day, payload, updated_at, total_queries
    FROM traffic_map_daily_snapshots
    WHERE day >= date('now', ?)
    ORDER BY day ASC
  `).all(`-${days - 1} days`);

  if (rows.length === 0) return null;

  const sources = new Map();
  const destinations = new Map();
  const routes = new Map();
  let totalQueries = 0;

  for (const row of rows) {
    totalQueries += row.total_queries || 0;
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    for (const source of payload.sources || []) mergeTrafficMapItems(sources, source);
    for (const destination of payload.destinations || []) mergeTrafficMapItems(destinations, destination);
    for (const route of payload.routes || []) {
      mergeTrafficMapRoute(routes, {
        sourceCountry: route.sourceCountry ?? route.source_country,
        sourceLat: route.sourceLat ?? route.source_lat,
        sourceLng: route.sourceLng ?? route.source_lng,
        destinationCountry: route.destinationCountry ?? route.destination_country,
        destinationLat: route.destinationLat ?? route.destination_lat,
        destinationLng: route.destinationLng ?? route.destination_lng,
        count: route.count || 0,
      });
    }
  }

  return {
    sources: [...sources.values()].sort((a, b) => b.count - a.count),
    destinations: [...destinations.values()].sort((a, b) => b.count - a.count),
    routes: [...routes.values()].sort((a, b) => b.count - a.count),
    totalQueries,
    dailyHistory: readTrafficMapDailyHistory(),
    lastRefresh: readTrafficMapLastRefresh(),
    dataRange: {
      oldest: `${rows[0].day}T00:00:00Z`,
      latest: `${rows[rows.length - 1].day}T23:59:59Z`,
    },
    logsCount: totalQueries,
    updatedAt: Date.now(),
  };
}

async function buildTrafficMapData(range = '24h') {
  const aggregateData = range === '24h'
    ? buildTrafficMapDataFromAggregateTables()
    : buildTrafficMapDataFromDailySnapshots(range);
  if (aggregateData) return aggregateData;
  return buildTrafficMapDataFromLogs(range);
}

async function emitTrafficMapData(socket, range = '24h', source = 'cache') {
  const data = await buildTrafficMapData(range);
  const lastRefresh = readTrafficMapLastRefresh();
  const syncState = db.prepare('SELECT last_synced_ts FROM sync_state WHERE key = ?').get(lastRefresh ? 'traffic_map_graphql' : 'traffic_map');
  const cachedAt = source === 'live'
    ? new Date().toISOString()
    : lastRefresh?.updatedAt || (syncState?.last_synced_ts
      ? new Date(syncState.last_synced_ts * 1000).toISOString()
      : null);
  socket.emit('traffic_map_data', {
    success: true,
    ...data,
    range,
    source,
    cachedAt,
  });
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

  // IPv4 Gateway Location Management API
  socket.on('get_gateway_location_ipv4', async () => {
    try {
      socket.emit('log', `\x1b[36mLoading Cloudflare Gateway location ${GATEWAY_LOCATION_ID}...\x1b[0m\n`);
      const response = await requestGateway(`/locations/${GATEWAY_LOCATION_ID}`, { method: "GET" });
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
    const cleanIpv4 = String(ipv4 || "").trim();
    try {
      if (isIP(cleanIpv4) !== 4) {
        throw new Error("Enter a valid IPv4 address.");
      }

      const newNetwork = `${cleanIpv4}/32`;
      socket.emit('log', `\x1b[36mFetching current Cloudflare Gateway location before update...\x1b[0m\n`);
      const currentResponse = await requestGateway(`/locations/${GATEWAY_LOCATION_ID}`, { method: "GET" });
      if (currentResponse?.success === false) throw new Error(JSON.stringify(currentResponse.errors));

      const currentLocation = currentResponse?.result;
      if (!currentLocation?.id) throw new Error("Cloudflare did not return a Gateway location.");

      const oldNetwork = getPrimaryIpv4Network(currentLocation) || "none";
      socket.emit('log', `Current protected source IPv4 network: ${oldNetwork}\n`);
      socket.emit('log', `Requested protected source IPv4 network: ${newNetwork}\n`);

      const updatePayload = buildGatewayLocationUpdatePayload(currentLocation, newNetwork);
      const updateResponse = await requestGateway(`/locations/${GATEWAY_LOCATION_ID}`, {
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
      const finalDomains = await prepareCustomListDomains({ action, listId, domains, socket });
      if (finalDomains.length === 0) return;

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
