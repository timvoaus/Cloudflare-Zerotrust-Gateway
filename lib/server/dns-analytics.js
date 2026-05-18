/**
 * DNS Analytics module for Cloudflare Gateway analytics.
 * Handles GraphQL sync, SQLite cache, and data building.
 */

// Module state
let db = null;
let accountId = null;
let apiToken = null;

// Environment configuration
function readPositiveIntegerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const DNS_ANALYTICS_RETENTION_DAYS = readPositiveIntegerEnv('DNS_ANALYTICS_RETENTION_DAYS', 30);

/**
 * Initialize the DNS analytics module with dependencies.
 * @param {Object} deps - Dependencies
 * @param {Object} deps.database - SQLite DatabaseSync instance
 * @param {string} deps.accountId - Cloudflare account ID
 * @param {string} deps.apiToken - Cloudflare API token
 */
export function initDNSAnalytics(deps) {
  db = deps.database;
  accountId = deps.accountId;
  apiToken = deps.apiToken;
}

function get15MinBucketTs(timestampMs) {
  return Math.floor(timestampMs / (15 * 60 * 1000)) * (15 * 60);
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

// GraphQL query functions
async function fetchDNSTimeSeriesData(hours = 24) {
  const now = new Date();
  const startTime = new Date(now - hours * 60 * 60 * 1000).toISOString();
  const endTime = now.toISOString();

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
    accountTag: accountId,
    start: startTime,
    end: endTime,
  };

  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiToken}`,
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

  const buckets = new Map();

  data.forEach(item => {
    const timeStr = item.dimensions?.datetimeMinute || item.dimensions?.datetimeHour;
    if (!timeStr) return;

    const date = new Date(timeStr);

    if (intervalMinutes >= 60) {
      date.setMinutes(0, 0, 0);
    } else {
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
            filter: { datetime_geq: $start, datetime_leq: $end }
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
    accountTag: accountId,
    start: startTime,
    end: endTime,
    limit,
  };

  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiToken}`,
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
    accountTag: accountId,
    start: startTime,
    end: endTime,
    limit,
  };

  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiToken}`,
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
              decision: resolverDecision
            }
          }
        }
      }
    }
  `;

  const variables = {
    accountTag: accountId,
    start: startTime,
    end: endTime,
  };

  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiToken}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await response.json();

  if (!response.ok || data.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(data.errors || data)}`);
  }

  const scope = data.data?.viewer?.scope?.[0];
  const decisionsData = scope?.data || [];

  const RESOLVER_DECISION_LABELS = {
    '5': 'Allowed on no policy match',
    '9': 'Blocked rule',
    '10': 'Allowed rule',
  };

  return decisionsData.map(item => ({
    metric: item.dimensions?.decision,
    label: RESOLVER_DECISION_LABELS[item.dimensions?.decision] || `Decision ${item.dimensions?.decision}`,
    count: item.count || 0,
  }));
}

// Sync function
export async function syncDNSAnalyticsToDatabase(forceFull = false) {
  if (!accountId || !apiToken) {
    console.log('DNS analytics sync skipped: missing credentials');
    return;
  }

  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  let fromSec = nowSec - 24 * 60 * 60;

  if (!forceFull) {
    const stmt = db.prepare('SELECT last_synced_ts FROM sync_state WHERE key = ?');
    const row = stmt.get('dns_analytics');
    if (row?.last_synced_ts) {
      fromSec = Math.max(row.last_synced_ts - 60 * 60, nowSec - 24 * 60 * 60);
    }
  }

  const startTime = new Date(fromSec * 1000).toISOString();
  const endTime = new Date(nowMs).toISOString();

  console.log(`Starting DNS analytics sync: ${startTime} to ${endTime}`);

  try {
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
      accountTag: accountId,
      start: startTime,
      end: endTime,
      limit: 100
    };

    const [timeSeriesRes, domainsRes, locationsRes, decisionsRes] = await Promise.all([
      fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
        body: JSON.stringify({ query: timeSeriesQuery, variables })
      }).then(r => r.json()),
      fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
        body: JSON.stringify({ query: topDomainsQuery, variables: { ...variables, limit: 100 } })
      }).then(r => r.json()),
      fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
        body: JSON.stringify({ query: topLocationsQuery, variables: { ...variables, limit: 100 } })
      }).then(r => r.json()),
      fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
        body: JSON.stringify({ query: decisionsQuery, variables })
      }).then(r => r.json())
    ]);

    const tsData = timeSeriesRes.data?.viewer?.scope?.[0]?.sparkline || [];
    const domainsData = domainsRes.data?.viewer?.scope?.[0]?.data || [];
    const locationsData = locationsRes.data?.viewer?.accounts?.[0]?.data || [];
    const decisionsData = decisionsRes.data?.viewer?.scope?.[0]?.data || [];

    db.exec('BEGIN TRANSACTION');
    try {
      const insertTs = db.prepare('INSERT OR REPLACE INTO dns_timeseries (bucket_ts, count) VALUES (?, ?)');
      for (const item of tsData) {
        const ts = new Date(item.dimensions?.ts).getTime();
        if (!Number.isFinite(ts)) continue;
        const bucketTs = get15MinBucketTs(ts);
        insertTs.run(bucketTs, item.count || 0);
      }

      const insertDomain = db.prepare('INSERT OR REPLACE INTO dns_top_domains (bucket_ts, domain, count) VALUES (?, ?, ?)');
      for (const item of domainsData) {
        const ts = new Date(item.dimensions?.ts).getTime();
        if (!Number.isFinite(ts)) continue;
        const bucketTs = get15MinBucketTs(ts);
        insertDomain.run(bucketTs, item.dimensions?.queryName || 'N/A', item.count || 0);
      }

      const insertLocation = db.prepare('INSERT OR REPLACE INTO dns_top_locations (bucket_ts, location, count) VALUES (?, ?, ?)');
      for (const item of locationsData) {
        const ts = new Date(item.dimensions?.ts).getTime();
        if (!Number.isFinite(ts)) continue;
        const bucketTs = get15MinBucketTs(ts);
        insertLocation.run(bucketTs, item.dimensions?.locationName || 'Unknown', item.count || 0);
      }

      const insertDecision = db.prepare('INSERT OR REPLACE INTO dns_resolver_decisions (bucket_ts, decision, count) VALUES (?, ?, ?)');
      for (const item of decisionsData) {
        const ts = new Date(item.dimensions?.ts).getTime();
        if (!Number.isFinite(ts)) continue;
        const bucketTs = get15MinBucketTs(ts);
        const decision = String(item.dimensions?.metric || '');
        insertDecision.run(bucketTs, decision, item.count || 0);
      }

      const retentionCutoff = nowSec - DNS_ANALYTICS_RETENTION_DAYS * 24 * 60 * 60;
      db.prepare('DELETE FROM dns_timeseries WHERE bucket_ts < ?').run(retentionCutoff);
      db.prepare('DELETE FROM dns_top_domains WHERE bucket_ts < ?').run(retentionCutoff);
      db.prepare('DELETE FROM dns_top_locations WHERE bucket_ts < ?').run(retentionCutoff);
      db.prepare('DELETE FROM dns_resolver_decisions WHERE bucket_ts < ?').run(retentionCutoff);

      db.prepare(`
        INSERT INTO sync_state (key, last_synced_ts, oldest_synced_ts)
        VALUES ('dns_analytics', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          last_synced_ts = excluded.last_synced_ts,
          oldest_synced_ts = COALESCE(oldest_synced_ts, excluded.oldest_synced_ts)
      `).run(nowSec, fromSec);

      db.exec('COMMIT');
      console.log(`DNS analytics sync complete. Time series: ${tsData.length} buckets, Domains: ${domainsData.length}, Locations: ${locationsData.length}, Decisions: ${decisionsData.length}`);
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } catch (err) {
    console.error('DNS analytics sync failed:', err);
    throw err;
  }
}

// Cache builder functions
export function buildDNSAnalyticsDataFromCache(range = '24h') {
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

// Live data fetchers for direct use
export { fetchDNSTimeSeriesData, fetchTopDomains, fetchTopLocations, fetchResolverDecisions };
