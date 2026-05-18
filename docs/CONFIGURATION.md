# Configuration reference

Copy `.env.default` to `.env` and edit values there. Docker Compose can set `CZGS_ENV_PATH` to persist dashboard-edited URLs on a volume.

## Required

| Variable | Description |
|----------|-------------|
| `CLOUDFLARE_API_TOKEN` | API token with Zero Trust Gateway edit permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |

## List processing & sync

| Variable | Default | Description |
|----------|---------|-------------|
| `CLOUDFLARE_LIST_ITEM_LIMIT` | `300000` | Max blocked domains to process |
| `GATEWAY_PATCH_CHUNK_SIZE` | `500` | Max items per Gateway list PATCH |
| `CZGS_API_CONCURRENCY` | `3` | Parallel read requests to Cloudflare |
| `CZGS_DOWNLOAD_CONCURRENCY` | `3` | Parallel block/allow list downloads |
| `CZGS_SKIP_SYNC_IF_UNCHANGED` | `1` | Skip list sync when manifest unchanged |
| `CZGS_FORCE_SYNC` | `0` | Force sync even when unchanged |
| `CZGS_AUTO_DEFRAGMENT` | `0` | Run defragment after Quick Update |
| `ALLOWLIST_URLS` | (built-in defaults) | Newline-separated allowlist URLs |
| `BLOCKLIST_URLS` | (built-in defaults) | Newline-separated blocklist URLs |
| `DRY_RUN` | `0` | Process files only; no Cloudflare writes |

## Dashboard & security

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3333` | HTTP port |
| `HOST` | `127.0.0.1` / `0.0.0.0` in Docker | Bind address |
| `DASHBOARD_USERNAME` | `admin` | Basic auth username |
| `DASHBOARD_PASSWORD` | (empty) | Required for non-localhost access |
| `DASHBOARD_AUTH_DISABLED` | `0` | Only use behind another access layer |

## Traffic map & analytics

See comments in `.env.default` for `TRAFFIC_MAP_*` variables.

## Data paths (Docker)

| Variable | Description |
|----------|-------------|
| `CZGS_DATA_DIR` | SQLite and runtime data directory |
| `CZGS_ENV_PATH` | Path to persisted `.env` for URL edits |

See [README.md](../README.md#environment-variables) for the full table including optional features.
