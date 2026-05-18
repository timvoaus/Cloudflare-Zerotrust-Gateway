# Cloudflare Zero Trust Gateway Scripts Dashboard

Cloudflare Zero Trust Gateway Scripts (CZGS) helps you build, maintain, and manage Cloudflare Gateway DNS filter lists from public blocklists and allowlists. The project includes a web dashboard, a terminal menu, Docker deployment files, and direct Node.js scripts for automation-focused workflows.

The dashboard can download configured lists, normalize domains, sync Cloudflare Gateway lists, create or update Gateway firewall rules, manage list source URLs, manage a custom allowlist, and review DNS traffic-map data.

## Project Foundation

This project builds on the backend foundation provided by [`mrrfv/cloudflare-gateway-pihole-scripts`](https://github.com/mrrfv/cloudflare-gateway-pihole-scripts). The backend has been adapted and extended to support this project's configuration model, dashboard workflow, Cloudflare Zero Trust Gateway automation, Docker deployment approach, and tailored management features.

## Acknowledgements

- Backend foundation inspired by and adapted from [`mrrfv/cloudflare-gateway-pihole-scripts`](https://github.com/mrrfv/cloudflare-gateway-pihole-scripts).
- This project was heavily developed using AI-assisted workflows and vibe coding techniques to accelerate prototyping, feature development, refactoring, and documentation.

## Features

- Web dashboard on port `3333`
- Real-time terminal output through Socket.IO
- Cloudflare API credential setup through `.env` or environment variables
- Blocklist and allowlist URL management
- Custom allowlist management with an allow rule
- Traffic-map history using Cloudflare analytics and local SQLite snapshots
- Docker and Docker Compose support
- Direct CLI scripts for automation and advanced use

## Dashboard Security

Localhost access works without a password. Remote dashboard access is blocked by default unless you set `DASHBOARD_PASSWORD` or explicitly set `DASHBOARD_AUTH_DISABLED=1`.

What this means in practice:

1. On your own machine, opening `http://127.0.0.1:3333` or `http://localhost:3333` works without dashboard login by default.
2. If you publish the dashboard through Docker port mapping, a VPS public IP, a reverse proxy, or any non-localhost address, the app will reject access unless you set `DASHBOARD_PASSWORD`.
3. When `DASHBOARD_PASSWORD` is set, the dashboard uses HTTP Basic Auth.
4. `DASHBOARD_AUTH_DISABLED=1` should only be used when another trusted layer already protects the app, such as Cloudflare Access, a private VPN, Tailscale, or an internal-only reverse proxy.

Recommended patterns:

1. Local development only:
   Leave `DASHBOARD_PASSWORD` empty and use `http://localhost:3333`.
2. Docker on a remote host:
   Set both `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD`, then avoid exposing port `3333` directly unless you also trust the network path.
3. Cloudflare Tunnel or reverse proxy:
   Keep `DASHBOARD_PASSWORD` enabled unless Cloudflare Access, a VPN, or another trusted access layer already protects the dashboard.
4. Fully private network:
   `DASHBOARD_AUTH_DISABLED=1` is reasonable only if the service is unreachable from untrusted clients.

If you deploy this on a VPS or any shared network, set a dashboard password and avoid exposing port `3333` directly to the public internet.

Recommended protection:

1. Set `DASHBOARD_PASSWORD`.
2. Keep the dashboard behind a private network, VPN, or Cloudflare Tunnel.
3. Put Cloudflare Access in front of the tunnel when publishing it through Cloudflare.
4. Never commit `.env`, `allowlist.txt`, `blocklist.txt`, or other generated/local files.

Basic auth protects the dashboard application, but it should still be served through HTTPS or Cloudflare Access when used remotely.

Example remote `.env` settings:

```ini
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=choose_a_long_random_password
# Leave this at 0 unless another trusted access layer protects the app
DASHBOARD_AUTH_DISABLED=0
```

## Requirements

- Cloudflare Zero Trust account
- Cloudflare Account ID
- Cloudflare API Token with Zero Trust Gateway read/edit permissions
- Docker, or Node.js 24.x for local development

## Quick Start With Docker

Create a `.env` file:

```ini
CLOUDFLARE_API_TOKEN=your_token_here
CLOUDFLARE_ACCOUNT_ID=your_account_id_here
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=choose_a_strong_password
TRAFFIC_MAP_HOURS=24
TRAFFIC_MAP_ROW_LIMIT=10000
TRAFFIC_MAP_SYNC_COOLDOWN_SECONDS=300
```

Build and run your own local image:

```bash
docker build -t czgs-dashboard:local .
docker run -d \
  --name czgs-dashboard \
  -p 3333:3333 \
  --env-file .env \
  -e CZGS_DATA_DIR=/usr/src/app/data \
  -e CZGS_ENV_PATH=/usr/src/app/data/.env \
  -v czgs-data:/usr/src/app/data \
  --restart unless-stopped \
  czgs-dashboard:local
```

Open:

```text
http://localhost:3333
```

On a remote server, replace `localhost` with the server address only if access is protected.

Traffic map aggregates and daily snapshots are stored in SQLite under `CZGS_DATA_DIR` and should be mounted to persistent storage. The 24-hour map is refreshed from Cloudflare GraphQL analytics aggregates, while 7-day and 30-day map ranges are built from locally saved daily snapshots. Dashboard-edited URL settings are stored at `CZGS_ENV_PATH`, which also points into the same persistent Docker volume in the included Compose file. Normal container restarts, image updates, and VPS reboots keep both the traffic database and saved URL settings. Do not remove the Docker volume unless you intentionally want to reset dashboard history and saved URL edits.

## Docker Compose

Create `.env` first, then build and run from source:

```bash
docker compose up -d --build
```

The included `docker-compose.yml` builds locally from this repository.

## Local Node.js Setup

Install dependencies:

```bash
npm install
```

Start the web dashboard:

```bash
npm run web
```

Open:

```text
http://localhost:3333
```

Before running, ensure you have created a local environment file and added your Cloudflare credentials:

```bash
cp .env.default .env
# Edit .env and set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
```

For remote local-development access, set `DASHBOARD_PASSWORD` in `.env`.

## Dashboard Workflow

Before starting the dashboard, ensure you have configured your Cloudflare credentials in your `.env` file or as environment variables.

1. **Launch the Dashboard**: Open `http://localhost:3333` in your browser.
2. **Manage Sources**: Under **Manage URLs**, you can customize which public blocklists and allowlists the script should pull from.
3. **Execute Update**: Return to the **Quick Update** tab and click **Run Update**. This will:
   - Download and merge all remote lists.
   - Normalize domains and remove duplicates.
   - Sync the results to Cloudflare Gateway lists, chunked into groups of 1,000.
   - Create or update the Gateway DNS firewall rule.
4. **Custom Allowlist**: Use the **Custom Allowlist** tab to manage specific domains that should always be accessible, regardless of what is in the blocklists.
5. **Verify Rule Order**: Log in to your [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/) and navigate to **Gateway > Firewall Policies > DNS**. Ensure that the `Gateway Custom Allow Rule` is positioned **above** the `CZGS Filter Lists` rule. Rules are evaluated from top to bottom.

Full Reset deletes only generated CZGS block resources: lists named `CZGS List...` and rules named `CZGS Filter Lists...`. It preserves the custom allowlist and custom allow rule.

## CLI Commands

The dashboard calls the same scripts that are available from the command line:

```bash
npm run download                 # Download allowlist.txt and blocklist.txt
npm run cloudflare-create:list   # Normalize and sync Gateway lists
npm run cloudflare-create:rule   # Create or update Gateway block rule
npm run cloudflare-create        # Run list sync and rule upsert
npm run cloudflare-refresh       # Download, sync lists, and upsert rule
npm run cloudflare-defragment    # Repack existing CZGS lists
npm run dry                      # Cross-platform dry run
npm run menu                     # Open the interactive terminal menu
npm run web                      # Start the web dashboard
```

Deletion scripts are guarded. To intentionally delete CZGS lists or rules, set:

```ini
CZGS_DELETION_ENABLED=true
```

Then run:

```bash
npm run cloudflare-delete
```

## Dry Run

Run:

```bash
npm run dry
```

Dry run mode processes the downloaded list files but does not create or update Cloudflare Gateway lists.

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Yes | Cloudflare API token. Prefer this over a global API key. |
| `CLOUDFLARE_ACCOUNT_ID` | Yes | Cloudflare account ID. |
| `CLOUDFLARE_LIST_ITEM_LIMIT` | No | Maximum number of blocked domains to process. Default: `300000`. |
| `ALLOWLIST_URLS` | No | Newline-separated list of allowlist source URLs. |
| `BLOCKLIST_URLS` | No | Newline-separated list of blocklist source URLs. |
| `BLOCK_PAGE_ENABLED` | No | Set to `1` to enable a Gateway block page. |
| `BLOCK_BASED_ON_SNI` | No | Set to `1` to add experimental SNI-based filtering. |
| `DISCORD_WEBHOOK_URL` | No | Sends completion/error notifications to a Discord-compatible webhook. |
| `PORT` | No | Dashboard port. Default: `3333`. |
| `HOST` | No | Dashboard bind address. Defaults to `127.0.0.1` locally and `0.0.0.0` in Docker. |
| `DASHBOARD_USERNAME` | No | Basic auth username for remote dashboard access. Default: `admin`. |
| `DASHBOARD_PASSWORD` | Recommended | Enables authenticated remote dashboard access. |
| `DASHBOARD_AUTH_DISABLED` | No | Set to `1` only if another trusted layer protects the dashboard. |
| `DASHBOARD_ALLOWED_ORIGINS` | No | Comma-separated Socket.IO CORS origins for advanced reverse-proxy setups. |
| `TRAFFIC_MAP_HOURS` | No | How far back the traffic-map GraphQL aggregate sync looks. Default: `24`, hard-capped at `24`. |
| `TRAFFIC_MAP_ROW_LIMIT` | No | Maximum grouped rows requested from Cloudflare GraphQL per traffic-map dimension. Default: `10000`. |
| `TRAFFIC_MAP_SYNC_COOLDOWN_SECONDS` | No | Minimum age before another traffic-map GraphQL sync is attempted. Default: `300`. |
| `TRAFFIC_MAP_DISPLAY_HOURS` | No | Hours of saved local SQLite traffic history to plot. Set `0` to plot all saved local history. Default: `0`. |
| `TRAFFIC_MAP_RETENTION_DAYS` | No | Days of fallback local SQLite activity logs to keep. Set `0` to keep logs indefinitely. Default: `30`. |
| `TRAFFIC_MAP_RETENTION_HOURS` | No | Legacy hourly retention override used only when `TRAFFIC_MAP_RETENTION_DAYS` is unset. |
| `TRAFFIC_MAP_ACTIVITY_LIMIT` | No | Fallback Cloudflare Gateway activity rows requested per page if GraphQL sync fails. Default: `5000`. |
| `TRAFFIC_MAP_MAX_ACTIVITY_PAGES` | No | Fallback maximum Cloudflare Gateway activity pages fetched per sync if GraphQL sync fails. Default: `20`. |
| `CZGS_DELETION_ENABLED` | No | Must be set before deletion scripts will remove lists/rules. |

## Generated Files

These files are generated locally and should not be committed:

- `.env`
- `allowlist.txt`
- `blocklist.txt`
- `czgs.zip`
- log files
- `node_modules/`
