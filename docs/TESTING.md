# Manual testing checklist

Run after meaningful code changes. No Cloudflare credentials are required for `npm test`.

## Automated

```bash
npm test
npm run dry
```

## Fresh install

1. `cp .env.default .env` and set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
2. `npm install`
3. `npm run web` — open http://localhost:3333
4. `curl http://localhost:3333/api/health` — expect `"ok": true`

## Quick Update

1. Run **Quick Update** from the dashboard (or `npm run cloudflare-refresh`).
2. Confirm terminal progress bar advances through download, process, sync, and rule phases.
3. Confirm timing summary line at the end.
4. Run again without changing lists — sync should skip if `CZGS_SKIP_SYNC_IF_UNCHANGED=1` and CZGS lists exist.

## Cloudflare dashboard

1. **Gateway → Lists** — `CZGS List - Chunk *` lists populated.
2. **Gateway → Firewall Policies → DNS** — `Gateway Custom Allow Rule` above `CZGS Filter Lists`.

## Custom allowlist

1. Add and remove a test domain from the dashboard tab.
2. Confirm allow rule still references the list.

## Full reset

1. Run **Full Reset** from the dashboard.
2. Confirm custom allowlist and allow rule remain; CZGS block lists/rules are recreated after re-sync.

## Remote / Docker

1. Set `DASHBOARD_PASSWORD` when exposing port 3333 beyond localhost.
2. `docker compose up -d --build` — healthcheck should pass on `/api/health`.
