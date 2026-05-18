/**
 * Traffic Map module for Cloudflare Gateway analytics visualization.
 * Handles GraphQL sync, SQLite aggregate storage, and data building.
 */

import { isIP } from 'node:net';
import geoip from 'geoip-lite';

// Country centroids for fallback when geoip fails
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
  CF: [6.6111, 20.9390], CG: [-0.2280, 15.8277], CH: [46.8182, 8.2275],
  CI: [7.5400, -5.5471], CL: [-35.6751, -71.5430], CM: [7.3697, 12.3547],
  CN: [35.8617, 104.1954], CO: [4.5709, -74.2973], CR: [9.7489, -83.7534],
  CU: [21.5218, -77.7812], CV: [16.5388, -23.0418], CY: [35.1264, 33.4299],
  CZ: [49.8175, 15.4730], DE: [51.1657, 10.4515], DJ: [11.8251, 42.5903],
  DK: [56.2639, 9.5018], DM: [15.4150, -61.3710], DO: [18.7357, -70.1627],
  DZ: [28.0339, 1.6596], EC: [-1.8312, -78.1834], EE: [58.5953, 25.0136],
  EG: [26.8206, 30.8025], ER: [15.1794, 39.7823], ES: [40.4637, -3.7492],
  ET: [9.1450, 40.4897], FI: [61.9241, 25.7482], FJ: [-17.7134, 178.0650],
  FM: [7.4256, 150.5508], FR: [46.2276, 2.2137], GA: [-0.8037, 11.6094],
  GB: [55.3781, -3.4360], GD: [12.2628, -61.6042], GE: [42.3154, 43.3569],
  GH: [7.9465, -1.0232], GM: [13.4432, -15.3101], GN: [9.9456, -9.6966],
  GQ: [1.6508, 10.2679], GR: [39.0742, 21.8243], GT: [15.7835, -90.2308],
  GW: [11.8037, -15.1804], GY: [4.8604, -58.9302], HN: [15.2000, -86.2419],
  HR: [45.1000, 15.2000], HT: [18.9712, -72.2852], HU: [47.1625, 19.5033],
  ID: [-0.7893, 113.9213], IE: [53.1424, -7.6921], IL: [31.0461, 34.8516],
  IN: [20.5937, 78.9629], IQ: [33.2232, 43.6793], IR: [32.4279, 53.6880],
  IS: [64.9631, -19.0208], IT: [41.8719, 12.5674], JM: [18.1096, -77.2975],
  JO: [30.5852, 36.2384], JP: [36.2048, 138.2529], KE: [-0.0236, 37.9062],
  KG: [41.2044, 74.7661], KH: [12.5657, 104.9910], KI: [-3.3704, -168.7340],
  KM: [-11.6455, 43.3333], KN: [17.3578, -62.7820], KP: [40.3399, 127.5101],
  KR: [35.9078, 127.7669], KW: [29.3117, 47.4818], KZ: [48.0196, 66.9237],
  LA: [19.8563, 102.4955], LB: [33.8547, 35.8623], LI: [47.1660, 9.5554],
  LK: [7.8731, 80.7718], LR: [6.4281, -9.4295], LS: [-29.6100, 28.2336],
  LT: [55.1694, 23.8813], LU: [49.8153, 6.1296], LV: [56.8796, 24.6032],
  LY: [26.3351, 17.2283], MA: [31.7917, -7.0926], MC: [43.7503, 7.4128],
  MD: [47.4116, 28.3699], ME: [42.7087, 19.3744], MG: [-18.7669, 46.8691],
  MH: [7.1315, 171.1845], MK: [41.6086, 21.7453], ML: [17.5707, -3.9962],
  MM: [21.9140, 95.9562], MN: [46.8625, 103.8467], MR: [21.0079, -10.9404],
  MT: [35.9375, 14.3754], MU: [-20.3484, 57.5522], MV: [3.2028, 73.2207],
  MW: [-13.2543, 34.3015], MX: [23.6345, -102.5528], MY: [4.2105, 101.9758],
  MZ: [-18.6657, 35.5296], NA: [-22.9576, 18.4904], NE: [17.6078, 8.0817],
  NG: [9.0820, 8.6753], NI: [12.8654, -85.2072], NL: [52.1326, 5.2913],
  NO: [60.4720, 8.4689], NP: [28.3949, 84.1240], NR: [-0.5228, 166.9315],
  NZ: [-40.9006, 174.8869], OM: [21.4735, 55.9754], PA: [8.5380, -80.7821],
  PE: [-9.1900, -75.0152], PG: [-6.3150, 143.9555], PH: [12.8797, 121.7740],
  PK: [30.3753, 69.3451], PL: [51.9194, 19.1451], PT: [39.3999, -8.2245],
  PY: [-23.4425, -58.4438], QA: [25.3548, 51.1839], RO: [45.9432, 24.9668],
  RU: [61.5240, 105.3188], RW: [-1.9403, 29.8739], SA: [23.8859, 45.0792],
  SB: [-9.6457, 160.1562], SC: [-4.6796, 55.4920], SD: [12.8628, 30.2179],
  SE: [60.1282, 18.6435], SG: [1.3521, 103.8198], SI: [46.1512, 14.9955],
  SK: [48.6690, 19.6990], SL: [8.4606, -11.7799], SM: [43.9424, 12.4578],
  SN: [14.4974, -14.4524], SO: [5.1521, 46.1996], SR: [3.9193, -56.0278],
  SS: [6.8770, 31.3070], ST: [0.1864, 6.6131], SV: [13.7942, -88.8965],
  SY: [34.8021, 38.9968], SZ: [-26.5225, 31.4659], TD: [15.4542, 18.7322],
  TG: [8.6195, 0.8248], TH: [15.8700, 100.9925], TJ: [38.8610, 71.2761],
  TL: [-8.8742, 125.7275], TM: [38.9697, 59.3923], TN: [34.7739, 10.0135],
  TR: [38.9637, 35.2433], TT: [10.6918, -61.2225], TV: [-7.1095, 177.6493],
  TW: [23.6978, 120.9605], TZ: [-6.3690, 34.8888], UA: [48.3794, 31.1656],
  UG: [1.3733, 32.2903], US: [37.0902, -95.7129], UY: [-32.5228, -55.7658],
  UZ: [41.3775, 64.5853], VA: [41.9029, 12.4534], VC: [13.2528, -61.1971],
  VE: [6.4238, -66.5897], VN: [14.0583, 108.2772], VU: [-15.3767, 166.9590],
  WS: [-13.7590, -172.1046], YE: [15.5527, 48.5164], ZA: [-30.5595, 22.9375],
  ZM: [-13.1339, 27.8493], ZW: [-19.0154, 29.1549],
};

// Environment configuration
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

// Module state
let isTrafficMapGraphQLSyncing = false;
let db = null;
let accountId = null;
let apiToken = null;

/**
 * Initialize the traffic map module with dependencies.
 * @param {Object} deps - Dependencies
 * @param {Object} deps.database - SQLite DatabaseSync instance
 * @param {string} deps.accountId - Cloudflare account ID
 * @param {string} deps.apiToken - Cloudflare API token
 */
export function initTrafficMap(deps) {
  db = deps.database;
  accountId = deps.accountId;
  apiToken = deps.apiToken;
}

function normalizeCountryCode(value) {
  return String(value || '').trim().toUpperCase();
}

function extractResolvedIps(row) {
  const raw = row.resolved_ips || row.initial_resolved_ips;
  if (!raw) return [];
  const list = String(raw).split(',').map(ip => ip.trim()).filter(Boolean);
  return [...new Set(list)].filter(ip => isIP(ip) !== 0);
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

function uniqueTrafficMapCountries(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  for (const value of list) {
    const country = normalizeCountryCode(value);
    if (country) seen.add(country);
  }
  return [...seen];
}

const TRAFFIC_MAP_GRAPHQL_QUERY = `
query TrafficMap($acct: string!, $start: Time!, $end: Time!, $rowLimit: Int!) {
  viewer {
    accounts(filter: { accountTag: $acct }) {
      total: gatewayResolverQueriesAdaptiveGroups(
        filter: { datetime_geq: $start, datetime_leq: $end }
        limit: 1
      ) { count }
      rawSources: gatewayResolverQueriesAdaptiveGroups(
        filter: { datetime_geq: $start, datetime_leq: $end }
        limit: $rowLimit
        orderBy: [count_DESC]
      ) {
        count
        dimensions {
          srcIpCountry
        }
      }
      rawDestinations: gatewayResolverQueriesAdaptiveGroups(
        filter: { datetime_geq: $start, datetime_leq: $end }
        limit: $rowLimit
        orderBy: [count_DESC]
      ) {
        count
        dimensions {
          resolvedIpCountries
        }
      }
      rawRoutes: gatewayResolverQueriesAdaptiveGroups(
        filter: { datetime_geq: $start, datetime_leq: $end }
        limit: $rowLimit
        orderBy: [count_DESC]
      ) {
        count
        dimensions {
          srcIpCountry
          resolvedIpCountries
        }
      }
    }
  }
}`;

async function fetchTrafficMapGraphQLAggregate() {
  if (!accountId || !apiToken) {
    throw new Error('Traffic map GraphQL sync skipped: missing ACCOUNT_ID or API_TOKEN');
  }

  const end = new Date();
  const start = new Date(end.getTime() - TRAFFIC_MAP_GRAPHQL_HOURS * 60 * 60 * 1000);
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiToken}`,
    },
    body: JSON.stringify({
      query: TRAFFIC_MAP_GRAPHQL_QUERY,
      variables: {
        acct: accountId,
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
    rawSources: account.rawSources || [],
    rawDestinations: account.rawDestinations || [],
    rawRoutes: account.rawRoutes || [],
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
  };
}

function aggregateTrafficMapGraphQLRows(raw) {
  const sources = new Map();
  const destinations = new Map();
  const routes = new Map();
  const unmappedCountries = [];

  const noteUnmapped = (country) => {
    if (!unmappedCountries.includes(country)) {
      unmappedCountries.push(country);
    }
  };

  for (const row of raw.rawSources) {
    const country = normalizeCountryCode(row.dimensions?.srcIpCountry);
    if (!country) continue;
    const point = countryPoint(country);
    if (point.lat == null || point.lng == null) {
      noteUnmapped(country);
      continue;
    }
    const current = sources.get(country);
    if (current) {
      current.count += row.count || 0;
    } else {
      sources.set(country, { country, lat: point.lat, lng: point.lng, count: row.count || 0 });
    }
  }

  for (const row of raw.rawDestinations) {
    const countries = uniqueTrafficMapCountries(row.dimensions?.resolvedIpCountries);
    for (const country of countries) {
      const point = countryPoint(country);
      if (point.lat == null || point.lng == null) {
        noteUnmapped(country);
        continue;
      }
      const current = destinations.get(country);
      if (current) {
        current.count += row.count || 0;
      } else {
        destinations.set(country, { country, lat: point.lat, lng: point.lng, count: row.count || 0 });
      }
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
          destinationCountry,
          sourceLat: sourcePoint.lat,
          sourceLng: sourcePoint.lng,
          destinationLat: destinationPoint.lat,
          destinationLng: destinationPoint.lng,
          count: row.count || 0,
        });
      }
    }
  }

  return {
    sources: [...sources.values()].sort((a, b) => b.count - a.count),
    destinations: [...destinations.values()].sort((a, b) => b.count - a.count),
    routes: [...routes.values()].sort((a, b) => b.count - a.count),
    unmappedCountries,
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

    for (const item of agg.sources) {
      insertSource.run(item.country, item.lat, item.lng, item.count);
    }
    for (const item of agg.destinations) {
      insertDestination.run(item.country, item.lat, item.lng, item.count);
    }
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
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
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

export function isTrafficMapGraphQLSyncFresh() {
  const syncState = db.prepare('SELECT last_synced_ts FROM sync_state WHERE key = ?').get('traffic_map_graphql');
  if (!syncState?.last_synced_ts) return false;
  const ageSeconds = Math.floor(Date.now() / 1000) - syncState.last_synced_ts;
  return ageSeconds >= 0 && ageSeconds < TRAFFIC_MAP_SYNC_COOLDOWN_SECONDS;
}

export async function syncTrafficMapAggregatesToDatabase() {
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

function getCutoffForRange(range) {
  const nowSec = Math.floor(Date.now() / 1000);
  switch (range) {
    case '7d': return nowSec - 7 * 24 * 60 * 60;
    case '30d': return nowSec - 30 * 24 * 60 * 60;
    case '24h':
    default: return nowSec - 24 * 60 * 60;
  }
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

function buildTrafficMapDataFromLogs(range = '24h') {
  const cutoffSec = getCutoffForRange(range);
  const stmt = db.prepare('SELECT * FROM logs WHERE datetime >= ?');
  const dbLogs = stmt.all(cutoffSec);

  const logs = dbLogs.map(row => ({
    ...row,
    resolved_ips: row.resolved_ips ? JSON.parse(row.resolved_ips) : [],
  }));
  const sources = new Map();
  const destinations = new Map();
  const routes = new Map();

  for (const log of logs) {
    const sourceCountry = normalizeCountryCode(log.src_country_code || log.src_country);
    if (!sourceCountry) continue;

    const sourcePoint = countryPoint(sourceCountry);
    if (sourcePoint.lat == null || sourcePoint.lng == null) continue;

    let source = sources.get(sourceCountry);
    if (!source) {
      source = {
        country: sourceCountry,
        ...sourcePoint,
        count: 0,
      };
      sources.set(sourceCountry, source);
    }
    source.count += 1;

    const destIps = extractResolvedIps(log);
    for (const ip of destIps) {
      const geo = geoip.lookup(ip);
      const destCountry = geo?.country || 'Unknown';
      const destPoint = countryPoint(destCountry, geo);
      if (destPoint.lat == null || destPoint.lng == null) continue;

      let dest = destinations.get(destCountry);
      if (!dest) {
        dest = {
          country: destCountry,
          ...destPoint,
          count: 0,
        };
        destinations.set(destCountry, dest);
      }
      dest.count += 1;

      if (destCountry === sourceCountry) continue;
      const key = `${sourceCountry}->${destCountry}`;
      let route = routes.get(key);
      if (!route) {
        route = {
          sourceCountry,
          destinationCountry: destCountry,
          sourceLat: sourcePoint.lat,
          sourceLng: sourcePoint.lng,
          destinationLat: destPoint.lat,
          destinationLng: destPoint.lng,
          count: 0,
        };
        routes.set(key, route);
      }
      route.count += 1;
    }
  }

  return {
    sources: [...sources.values()].sort((a, b) => b.count - a.count),
    destinations: [...destinations.values()].sort((a, b) => b.count - a.count),
    routes: [...routes.values()].sort((a, b) => b.count - a.count),
    totalQueries: logs.length,
    dailyHistory: readTrafficMapDailyHistory(),
    lastRefresh: readTrafficMapLastRefresh(),
    dataRange: { oldest: new Date(cutoffSec * 1000).toISOString(), latest: new Date().toISOString() },
    logsCount: logs.length,
    updatedAt: Date.now(),
  };
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
        count: route.count,
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

export async function buildTrafficMapData(range = '24h') {
  const aggregateData = range === '24h'
    ? buildTrafficMapDataFromAggregateTables()
    : buildTrafficMapDataFromDailySnapshots(range);
  if (aggregateData) return aggregateData;
  return buildTrafficMapDataFromLogs(range);
}

export async function emitTrafficMapData(socket, range = '24h', source = 'cache') {
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

// Re-export environment constants for use by server.js
export {
  TRAFFIC_MAP_SYNC_COOLDOWN_SECONDS,
  TRAFFIC_MAP_HOURS,
  TRAFFIC_MAP_ACTIVITY_LIMIT,
  TRAFFIC_MAP_MAX_ACTIVITY_PAGES,
  TRAFFIC_MAP_ACTIVITY_FIELDS,
  TRAFFIC_MAP_COUNTRY_CENTROIDS
};
