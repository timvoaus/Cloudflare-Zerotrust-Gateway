# CZGS Architecture

## Overview

Cloudflare Zero Trust Gateway Scripts (CZGS) is a Node.js application that manages DNS filtering blocklists and allowlists for Cloudflare Gateway. It provides both a CLI menu interface and a web dashboard for managing domain lists, viewing traffic analytics, and monitoring DNS query patterns.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CZGS Application                                │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │   menu.js   │  │  server.js  │  │ Downloaders │  │   Sync Scripts  │  │
│  │   (CLI)     │  │  (Dashboard)│  │             │  │                 │  │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └────────┬────────┘  │
│         │                │                │                  │           │
│         └────────────────┴────────────────┴──────────────────┘           │
│                              │                                             │
│                    ┌─────────┴─────────┐                                  │
│                    │   lib/ modules    │                                  │
│                    │  • api.js         │                                  │
│                    │  • helpers.js     │                                  │
│                    │  • server/*.js    │                                  │
│                    └─────────┬─────────┘                                  │
│                              │                                             │
│  ┌───────────────────────────┼─────────────────────────────────────────┐  │
│  │          SQLite DB        │                                         │  │
│  │  ┌─────────────────────┐  │  ┌─────────────────────────────────┐   │  │
│  │  │      logs         │  │  │      analytics_cache              │   │  │
│  │  │  • traffic logs   │  │  │  • dns_timeseries                 │   │  │
│  │  │  • geo data       │  │  │  • dns_top_domains                │   │  │
│  │  └─────────────────────┘  │  │  • dns_top_locations              │   │  │
│  │                           │  │  • dns_resolver_decisions         │   │  │
│  │  ┌─────────────────────┐  │  └─────────────────────────────────┘   │  │
│  │  │   traffic_map_*   │  │                                          │  │
│  │  │  • sources        │  │                                          │  │
│  │  │  • destinations   │  │                                          │  │
│  │  │  • routes         │  │                                          │  │
│  │  │  • daily_snapshots│  │                                          │  │
│  │  └─────────────────────┘  │                                          │  │
│  └───────────────────────────┴─────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Cloudflare API (Zero Trust)                        │
│  • Gateway Lists (Allowlist/Blocklist)                                     │
│  • Gateway Rules (DNS Filtering)                                           │
│  • Gateway Analytics (Traffic Logs via GraphQL)                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Blocklist/Allowlist Pipeline

### Pipeline Flow

```
Source URLs (.env)          Processing                Cloudflare
     │                          │                         │
     ▼                          ▼                         ▼
┌──────────┐           ┌─────────────────┐      ┌─────────────────┐
│ BLOCKLIST│──────────▶│ download_lists  │─────▶│   CZGS Lists    │
│   URLS   │  Download │                 │      │  (10 domains    │
└──────────┘           │ • Normalize     │      │   per list)     │
                       │ • Deduplicate   │      └────────┬────────┘
┌──────────┐           │ • Sort          │               │
│ ALLOWLIST│──────────▶│                 │               │
│   URLS   │           └─────────────────┘               │
└──────────┘                                             │
                                                         ▼
                                               ┌─────────────────┐
                                               │   CZGS Filter   │
                                               │     Rules       │
                                               │  (DNS policy)   │
                                               └─────────────────┘
```

### Components

| Component | File | Purpose |
|-----------|------|---------|
| URL Sources | `.env` (`BLOCKLIST_URLS`, `ALLOWLIST_URLS`) | Raw domain list URLs |
| Downloader | `download_lists.js` | Downloads and aggregates source files |
| List Creator | `cf_list_create.js` | Creates/updates Cloudflare Gateway lists |
| Rule Creator | `cf_gateway_rule_create.js` | Creates/updates DNS filter rules |

### Data Flow

1. **Download Phase** (`download_lists.js`)
   - Reads `BLOCKLIST_URLS` and `ALLOWLIST_URLS` from environment
   - Downloads files with bounded concurrency (max 5 parallel)
   - Normalizes domains (lowercase, removes trailing dots)
   - Deduplicates and validates domains
   - Writes to `data/allowlist.txt` and `data/blocklist.txt`

2. **Sync Phase** (`cf_list_create.js`)
   - Reads local domain files
   - Compares with existing Cloudflare lists (manifest-based skip)
   - Calculates diffs (domains to add/remove)
   - Patches lists via Cloudflare API (chunked for large lists)
   - Updates manifest for incremental sync

3. **Rule Phase** (`cf_gateway_rule_create.js`)
   - Creates DNS firewall rule referencing allowlist/blocklist lists
   - Rule expression: `any(dns.domains[*] in $list_id)`
   - Supports optional SNI (TLS) rules

## Cloudflare Gateway List Sync

### Sync Architecture

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│  Local State    │      │  Diff Engine     │      │  Cloudflare API │
│                 │      │                  │      │                 │
│ • Domain files  │─────▶│ • Compare local  │─────▶│ • PATCH lists   │
│ • Manifest      │      │   vs remote     │      │ • Sequential    │
│ (hashes)        │      │ • Build patches │      │   updates       │
└─────────────────┘      └──────────────────┘      └─────────────────┘
```

### Sync Process (`lib/api.js`)

1. **Fetch Existing Lists**
   - `getZeroTrustLists()` - Lists all Gateway lists
   - `getZeroTrustListItemValues()` - Gets items for each list

2. **Calculate Diff**
   - Compares desired domains vs existing items
   - Determines `append` (add) and `remove` operations
   - Respects `LIST_ITEM_SIZE` limit (1000 items per list)

3. **Apply Patches**
   - `patchExistingListChunked()` - Handles large patches
   - Sequential PATCH requests to avoid API limits
   - Each patch: `{ append: [...], remove: [...] }`

4. **Manifest Management**
   - `manifest.json` stores content hashes
   - Skip-unchanged optimization for CI/CD
   - Tracks list IDs and item counts

## Dashboard/Server Flow

### Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                          Client (Browser)                           │
└────────────────────────────────────────────────────────────────────┘
                              │
                              │ HTTP / WebSocket
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│                           server.js                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │
│  │   Express   │  │  Socket.IO  │  │    Auth     │  │   Static    │  │
│  │   Routes    │  │  Events     │  │  Middleware │  │   Assets    │  │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └─────────────┘  │
│         │                │                │                          │
│         └────────────────┴────────────────┘                          │
│                          │                                          │
│                   ┌──────┴──────┐                                   │
│                   │  Route Handlers │                                │
│                   │  • /api/health  │                                │
│                   │  • Socket events│                                │
│                   └──────┬──────┘                                   │
│                          │                                          │
└──────────────────────────┼────────────────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────────────────┐
│                        lib/server/ Modules                         │
│  • dashboard-auth.js  - Authentication & authorization             │
│  • traffic-map.js     - Geo traffic visualization                │
│  • dns-analytics.js   - DNS query analytics                      │
│  • custom-gateway.js  - Allowlist/denylist operations            │
└────────────────────────────────────────────────────────────────────┘
```

### Authentication Flow

```
Request ──▶ Auth Middleware ──▶ isDashboardRequestAuthorized()
                               │
                               ├─▶ DASHBOARD_AUTH_DISABLED? → Allow
                               ├─▶ Localhost? → Allow (if no password)
                               └─▶ Basic Auth? → Validate credentials
```

### Socket.IO Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `run_update` | Client → Server | Trigger list download & sync |
| `full_reset` | Client → Server | Delete and recreate all lists/rules |
| `get_traffic_map` | Client → Server | Request traffic map data |
| `get_dns_analytics` | Client → Server | Request DNS analytics |
| `get_custom_allowlist` | Client → Server | Get custom allowlist items |
| `save_custom_allowlist` | Client → Server | Update allowlist |
| `script_progress` | Server → Client | Child process progress updates |
| `traffic_map_data` | Server → Client | Traffic map response |
| `dns_analytics_data` | Server → Client | Analytics response |

### Child Process Spawning

```
┌─────────────┐      ┌──────────────┐      ┌─────────────────┐
│   Client    │─────▶│   server.js  │─────▶│  spawn('node')  │
│  (Socket)   │      │              │      │                 │
└─────────────┘      │ • download   │      │ • download_lists│
      ▲              │   _lists.js  │      │ • cf_list_create│
      │              │ • cf_list_   │      │ • cf_gateway_   │
      │              │   create.js  │      │   rule_create   │
      │              │ • cf_gateway │      │                 │
      │              │   _rule_     │      └─────────────────┘
      │              │   create.js  │               │
      │              └──────────────┘               │
      │                     │                       │
      │              ┌──────┴──────┐              │
      │              │  stdout/stderr│              │
      └──────────────│  • CZGS_      │◀─────────────┘
                     │    PROGRESS   │
                     │  • Regular log│
                     └───────────────┘
```

## Traffic Map Data Flow

### Overview

The Traffic Map visualizes DNS query sources and destinations on a world map using two data sources:
- **GraphQL API** (recent data, aggregated)
- **Local SQLite** (historical logs, detailed)

### Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Data Sources                                │
├─────────────────────────────────┬───────────────────────────────────┤
│     Cloudflare GraphQL API      │      Local SQLite (logs)        │
│                                 │                                   │
│  • gatewayResolverQueries       │  • Gateway Activity API logs     │
│    AdaptiveGroups               │  • Parsed and geolocated          │
│  • Dimensions:                  │  • Stored with country codes      │
│    - srcIpCountry               │                                   │
│    - resolvedIpCountries        │                                   │
│                                 │                                   │
└───────────┬─────────────────────┴───────────────┬───────────────────┘
            │                                     │
            ▼                                     ▼
┌───────────────────────┐           ┌─────────────────────────┐
│   GraphQL Sync        │           │   Local Log Sync      │
│   (15-min interval)   │           │   (15-min interval)   │
│                       │           │                       │
│ • Aggregate sources   │           │ • Fetch activity logs │
│ • Aggregate destinations│         │ • Geolocate IPs       │
│ • Build route matrix  │           │ • Build route data    │
└───────────┬───────────┘           └───────────┬─────────────┘
            │                                   │
            └───────────────┬───────────────────┘
                          │
                          ▼
            ┌───────────────────────┐
            │     SQLite Storage    │
            │                       │
            │ • traffic_map_sources │
            │ • traffic_map_destinations│
            │ • traffic_map_routes  │
            │ • traffic_map_daily_snapshots│
            └───────────┬───────────┘
                        │
                        ▼
            ┌───────────────────────┐
            │     Dashboard API     │
            │                       │
            │ • get_traffic_map     │
            │   (range: 24h/7d/30d) │
            └───────────┬───────────┘
                        │
                        ▼
            ┌───────────────────────┐
            │   Client (D3.js Map)  │
            │                       │
            │ • Source bubbles      │
            │ • Destination bubbles │
            │ • Route arcs          │
            └───────────────────────┘
```

### Module: `lib/server/traffic-map.js`

| Function | Purpose |
|------------|---------|
| `initTrafficMap()` | Initialize with database and credentials |
| `syncTrafficMapAggregatesToDatabase()` | Fetch GraphQL and store aggregates |
| `isTrafficMapGraphQLSyncFresh()` | Check if cache is recent |
| `buildTrafficMapData()` | Build data for dashboard (range-based) |
| `emitTrafficMapData()` | Send data via Socket.IO |

### Data Tables

```sql
-- Aggregate tables (from GraphQL)
traffic_map_sources (country, lat, lng, count)
traffic_map_destinations (country, lat, lng, count)
traffic_map_routes (source_country, destination_country, ..., count)

-- Daily snapshots (for 7d/30d views)
traffic_map_daily_snapshots (day, total_queries, payload, updated_at)

-- Raw logs (from REST API)
logs (query_id, datetime, src_country, src_country_code, source_ip, resolved_ips)
```

## DNS Analytics Flow

### Overview

DNS Analytics provides time-series data on DNS queries, including:
- Query volume over time (15-minute buckets)
- Top queried domains
- Top query locations (Colos)
- Resolver decisions (blocked/allowed)

### Data Flow

```
Cloudflare GraphQL API
│
├─ gatewayResolverQueriesAdaptiveGroups
│  ├─ datetimeFifteenMinutes (time bucket)
│  ├─ count (query count)
│  ├─ queryName (domain)
│  ├─ locationName (colo)
│  └─ resolverDecision (action)
│
▼
┌─────────────────────────┐
│   syncDNSAnalyticsToDatabase()  │
│   (lib/server/dns-analytics.js) │
└─────────────────────────┘
│
▼
SQLite Tables:
├─ dns_timeseries (bucket_ts, count)
├─ dns_top_domains (bucket_ts, domain, count)
├─ dns_top_locations (bucket_ts, location, count)
└─ dns_resolver_decisions (bucket_ts, decision, count)
│
▼
┌─────────────────────────┐
│ buildDNSAnalyticsDataFromCache() │
│ • Aggregates 15m → 1h/6h buckets  │
│ • Range: 24h/7d/30d                │
└─────────────────────────┘
│
▼
Dashboard (Chart.js)
```

### Module: `lib/server/dns-analytics.js`

| Function | Purpose |
|----------|---------|
| `initDNSAnalytics()` | Initialize with database and credentials |
| `syncDNSAnalyticsToDatabase()` | Fetch GraphQL and store in SQLite |
| `buildDNSAnalyticsDataFromCache()` | Build aggregated data for dashboard |
| `fetchDNSTimeSeriesData()` | Raw GraphQL fetch (optional use) |
| `fetchTopDomains()` | Get top domains (optional use) |
| `fetchTopLocations()` | Get top locations (optional use) |
| `fetchResolverDecisions()` | Get decision breakdown (optional use) |

### Resolver Decision Codes

| Code | Label | Description |
|------|-------|-------------|
| 5 | Allowed on no policy match | No matching rule |
| 9 | Blocked rule | Matched block rule |
| 10 | Allowed rule | Matched allow rule |

## Docker Data Persistence

### Volume Architecture

```
Host Machine                    Docker Container
│                               │
│  ┌─────────────────┐         │  ┌─────────────────┐
│  │  Docker Volume  │─────────▶│  │  /app/data      │
│  │  czgs-data      │  mount    │  │                 │
│  └─────────────────┘         │  │  • SQLite DB     │
│                               │  │  • manifest.json│
│                               │  │  • *.txt files  │
│                               │  └─────────────────┘
│                               │
│  Data persists across:        │  Container can be
│  • Container restarts         │  recreated/updated
│  • Image updates              │  without data loss
│  • Host reboots               │
│                               │
│  Deleted by:                  │
│  • docker compose down -v     │
│  • docker volume rm czgs-data │
└───────────────────────────────┴─────────────────────┘
```

### Database Location

```
/app/
├── data/                    # Docker volume mount
│   ├── traffic_logs.db      # SQLite database
│   ├── manifest.json        # Sync state
│   ├── allowlist.txt        # Downloaded allowlist
│   └── blocklist.txt        # Downloaded blocklist
├── server.js                # Main application
├── lib/                     # Modules
└── public/                  # Dashboard assets
```

### Health Check

The Docker `HEALTHCHECK` polls `/api/health` every 30 seconds:

```json
{
  "ok": true,
  "cloudflareConfigured": true,
  "databaseWritable": true,
  "uptime": 3600,
  "version": "1.0.0"
}
```

## Module Structure

### Server Modules (`lib/server/`)

```
lib/server/
├── dashboard-auth.js      # Authentication & authorization
│   ├── DASHBOARD_* constants
│   ├── safeEqual()        # Timing-safe compare
│   ├── parseBasicAuth()   # Parse auth header
│   ├── isLoopbackRequest() # Check localhost
│   ├── isDashboardRequestAuthorized()
│   ├── requireDashboardAccess() # Express middleware
│   ├── createSocketAuthOptions() # Socket.IO options
│   └── logDashboardSecurityWarning()
│
├── custom-gateway.js      # Custom allowlist/denylist
│   ├── CUSTOM_* constants
│   ├── GENERATED_* constants
│   ├── RULE_ORDER_WARNING
│   ├── is*Name() helpers  # Name detection
│   ├── findCustom*()      # Find lists
│   ├── upsertAllowRule()  # Create/update allow rule
│   ├── upsertDenyRule()   # Create/update deny rule
│   ├── findOrCreateAllowlist()
│   └── findOrCreateDenylist()
│
├── traffic-map.js         # Traffic visualization
│   ├── TRAFFIC_MAP_* constants
│   ├── initTrafficMap()
│   ├── syncTrafficMapAggregatesToDatabase()
│   ├── isTrafficMapGraphQLSyncFresh()
│   ├── buildTrafficMapData()
│   └── emitTrafficMapData()
│
└── dns-analytics.js       # DNS query analytics
    ├── DNS_ANALYTICS_* constants
    ├── initDNSAnalytics()
    ├── syncDNSAnalyticsToDatabase()
    ├── buildDNSAnalyticsDataFromCache()
    ├── fetchDNSTimeSeriesData()
    ├── fetchTopDomains()
    ├── fetchTopLocations()
    └── fetchResolverDecisions()
```

### Shared Modules (`lib/`)

| Module | Purpose | Key Exports |
|--------|---------|-------------|
| `api.js` | Cloudflare API client | `getZeroTrustLists()`, `synchronizeZeroTrustLists()`, `patchExistingListChunked()` |
| `helpers.js` | HTTP utilities | `requestGateway()`, `fetchRetry()` |
| `constants.js` | Configuration | `ACCOUNT_ID`, `API_TOKEN`, `LIST_ITEM_SIZE` |
| `env.js` | Environment paths | `getEnvPath()` |
| `utils.js` | File operations | `downloadFiles()`, `fetchRetry()` |

## Data Retention

### SQLite Tables Retention

| Table | Retention | Purpose |
|-------|-----------|---------|
| `logs` | 30 days | Raw traffic logs for map |
| `dns_timeseries` | 30 days | DNS query volume history |
| `dns_top_domains` | 30 days | Domain popularity |
| `dns_top_locations` | 30 days | Geographic distribution |
| `dns_resolver_decisions` | 30 days | Block/allow stats |
| `traffic_map_sources` | Latest only | Current sources aggregate |
| `traffic_map_destinations` | Latest only | Current destinations aggregate |
| `traffic_map_routes` | Latest only | Current routes aggregate |
| `traffic_map_daily_snapshots` | 30 days | Historical aggregates |

### Cleanup Mechanism

```javascript
// Automatic cleanup in sync functions
const retentionCutoff = nowSec - RETENTION_DAYS * 24 * 60 * 60;
db.prepare('DELETE FROM table WHERE bucket_ts < ?').run(retentionCutoff);
```

## Environment Configuration

### Required Variables

```bash
CLOUDFLARE_ACCOUNT_ID=<account_id>
CLOUDFLARE_API_TOKEN=<api_token>
```

### Optional Variables

```bash
# Dashboard
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=<secure_password>
DASHBOARD_AUTH_DISABLED=0
DASHBOARD_ALLOWED_ORIGINS=https://example.com

# List Sources
BLOCKLIST_URLS="https://...\nhttps://..."
ALLOWLIST_URLS="https://...\nhttps://..."

# Traffic Map
TRAFFIC_MAP_HOURS=24
TRAFFIC_MAP_ROW_LIMIT=10000
TRAFFIC_MAP_SYNC_COOLDOWN_SECONDS=300
TRAFFIC_MAP_ACTIVITY_LIMIT=5000
TRAFFIC_MAP_MAX_ACTIVITY_PAGES=20

# DNS Analytics
DNS_ANALYTICS_RETENTION_DAYS=30

# Gateway Location
CLOUDFLARE_GATEWAY_LOCATION_ID=<location_id>
```

## Security Considerations

1. **Authentication**
   - Basic Auth for dashboard (password required for remote access)
   - Localhost bypass only when no password set
   - Socket.IO requests validated through same middleware

2. **API Credentials**
   - Cloudflare API token stored in environment
   - Token requires Gateway permissions only
   - Never logged or exposed to client

3. **Data Storage**
   - SQLite database in Docker volume
   - Domain lists stored locally
   - No sensitive data in logs

4. **Network**
   - Dashboard binds to 127.0.0.1 by default (local only)
   - Docker mode binds to 0.0.0.0
   - Health endpoint exposed before auth middleware

## Performance Characteristics

| Operation | Frequency | Duration | Notes |
|-----------|-----------|----------|-------|
| List sync | Manual / on start | 30-60s | Creates/updates lists |
| GraphQL sync | Every 15 min | 5-15s | Fetches aggregated data |
| Log sync | Every 15 min | 10-30s | Fetches detailed logs |
| Dashboard query | On demand | <100ms | Serves cached data |
| Child process | Manual | 30-120s | Full update pipeline |

## Contributing Guidelines

When adding features:

1. **Server-side logic** → Add to appropriate `lib/server/*.js` module
2. **API calls** → Use `lib/api.js` or `lib/helpers.js`
3. **Database schema** → Add to `server.js` init section
4. **Socket events** → Add handler in `server.js` Socket.IO section
5. **CLI commands** → Add to `menu.js` option handlers
6. **Documentation** → Update this file and `README.md`
