# CZGS Improvement Implementation Plan

**Project:** Cloudflare Zero Trust Gateway Scripts (CZGS)  
**Audience:** Personal use; shareable for others running their own instance  
**Last updated:** May 2026

This document is the full implementation plan for improving correctness, performance, maintainability, and share-readiness. Work is ordered by **impact and risk**: fix correctness first, then speed, then polish and refactor.

---

## Table of contents

1. [Goals and principles](#1-goals-and-principles)
2. [Current baseline](#2-current-baseline)
3. [Phased roadmap](#3-phased-roadmap)
4. [Phase 0 — Housekeeping](#phase-0--housekeeping-12-days)
5. [Phase 1 — Correctness](#phase-1--correctness-critical-35-days)
6. [Phase 2 — Performance](#phase-2--performance-58-days)
7. [Phase 3 — Observability and dashboard UX](#phase-3--observability-and-dashboard-ux-24-days)
8. [Phase 4 — Maintainability refactor](#phase-4--maintainability-refactor-12-weeks-incremental)
9. [Phase 5 — Share-ready packaging](#phase-5--share-ready-packaging-23-days)
10. [Phase 6 — Testing strategy](#phase-6--testing-strategy-ongoing)
11. [Configuration reference](#11-configuration-reference-after-improvements)
12. [Suggested timeline](#12-suggested-timeline)
13. [Scope control (what not to do)](#13-scope-control-what-not-to-do)
14. [Success metrics](#14-success-metrics)
15. [Recommended implementation order](#15-recommended-implementation-order)

---

## 1. Goals and principles

| Goal | Why it matters (personal + shared use) |
|------|------------------------------------------|
| **Correct sync** | Wrong or partial list sync is worse than a slow sync |
| **Faster updates** | Main pain on large blocklists is Cloudflare API + file processing |
| **Safe defaults** | Personal use on localhost; sharers may expose Docker on a VPS |
| **Easier to fork** | Clear docs, env vars, and smaller modules reduce support burden |
| **Observable runs** | Progress + timing so users know a run is working, not stuck |

### Principles

- Keep Cloudflare rate-limit behavior (429 → backoff already in `fetchRetry`).
- Prefer **bounded concurrency** (3–5), not unlimited parallel API calls.
- Do not change Cloudflare resource naming (`CZGS List…`, `CZGS Filter Lists`) without a migration note.
- Every phase should be shippable on its own (small commits / releases).

---

## 2. Current baseline

### Architecture (today)

```
download_lists.js  →  allowlist.txt / blocklist.txt
        ↓
cf_list_create.js  →  normalize, dedupe, subtract allowlist
        ↓
lib/api.js         →  synchronizeZeroTrustLists (Gateway lists)
        ↓
cf_gateway_rule_create.js  →  DNS (and optional SNI) firewall rule

Parallel path: server.js (Express + Socket.IO + SQLite) spawns the same scripts
menu.js          →  terminal UI over the same scripts
```

### Known limits (from code review)

| Area | Issue |
|------|--------|
| List items | Only **first 1,000** per list fetched (`per_page=1000`); no pagination |
| API sync | **Fully sequential** fetch + patch in `synchronizeZeroTrustLists` |
| Downloads | **Fully sequential** (intentional; can use capped parallelism) |
| File processing | Parent-domain allowlist checks repeat `extractDomain()` per blocklist line |
| `server.js` | ~2,600 lines; duplicated logic vs `menu.js` (allowlist, env URLs) |
| Tests | **None** in repository |
| README | Combined project overview, screenshots, setup, Docker, environment, and generated-file guidance now render cleanly |
| Docker | Docker Hub image dependency removed; users build their own local image during deploy |
| Traffic map | Uses Cloudflare GraphQL analytics aggregates for 24h data, with local SQLite daily snapshots for 7d/30d ranges and raw activity logs as fallback |

---

## 3. Phased roadmap

| Phase | Focus | Effort | User-visible win |
|-------|--------|--------|------------------|
| **0** | Housekeeping & docs | Small | Easier onboarding |
| **1** | Correctness (pagination, patch limits) | Medium | Reliable sync at scale |
| **2** | Performance (concurrency, indexing, DB) | Medium–Large | Faster Quick Update |
| **3** | Observability & UX | Small–Medium | Trust during long runs |
| **4** | Refactor for maintainability | Large | Easier contributions |
| **5** | Share-ready packaging | Small | Docker / CLI confidence |
| **6** | Testing | Ongoing | Safer changes |

---

## Phase 0 — Housekeeping (1–2 days)

**Purpose:** Clean base before behavior changes; low risk.

### 0.1 Fix README

**Status:** Mostly complete.

- README has been combined and fixed.
- Project overview, screenshots, setup, Docker, environment variables, and generated-file guidance are documented.
- Docker deployment now documents local image builds instead of a maintainer-owned Docker Hub image.
- Still optional: add **Personal vs remote deploy** table (localhost / Docker / VPS).
- Still optional: note **typical update duration** (first run vs incremental).

**Files:** `README.md`

**Acceptance:** README renders cleanly; new user can `cp .env.default .env` and `npm run web` without confusion.

### 0.2 Align environment documentation

**Status:** Partially complete.

- Traffic-map variables are documented and defaulted:
  - `TRAFFIC_MAP_HOURS=24`
  - `TRAFFIC_MAP_ROW_LIMIT=10000`
  - `TRAFFIC_MAP_SYNC_COOLDOWN_SECONDS=300`
- `TRAFFIC_MAP_SYNC_COOLDOWN_SECONDS` protects Cloudflare GraphQL from repeated dashboard refresh calls.
- Still pending: document planned tuning variables in `.env.default` when implementation starts.
- Placeholder: `CZGS_API_CONCURRENCY=3` (used in Phase 2).

**Files:** `.env.default`, `README.md` env table

### 0.3 Git / release hygiene (if publishing)

- Commit project as a coherent tree.
- Add `CHANGELOG.md` with semver-style entries per phase.
- Tag releases (e.g. `v1.1.0` after Phase 1).

**Acceptance:** Others can clone and run from a tagged release.

---

## Phase 1 — Correctness (critical, 3–5 days)

**Purpose:** Full list sync and safe API payloads. Complete **before** aggressive speed work.

### 1.1 Paginate Gateway list items

**Problem:** `getZeroTrustListItems` only reads one page. Sync may be incomplete if pagination is required.

**Implementation steps**

1. Add helper (e.g. `lib/gateway-lists.js` or extend `lib/api.js`):

   ```
   getAllZeroTrustListItems(listId):
     loop GET /lists/{id}/items?per_page=1000&page=N (or cursor per API docs)
     until no more pages
     return flat array of items
   ```

2. Confirm pagination fields in [Cloudflare Zero Trust Lists API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/lists/).

3. Replace single-page fetches in:
   - `lib/api.js` — `synchronizeZeroTrustLists`, `defragmentZeroTrustLists`
   - `menu.js` — `fetchCustomListItems`
   - `server.js` — `fetchCustomListItems`

4. Update logging: `Fetched N items from "CZGS List - Chunk X" (P pages)`.

**Acceptance**

- List with 1,000 items: all values included in diff.
- Warning about “only first 1000 entries” removed or only shown when API errors.

**Risk:** Wrong pagination parameter → empty pages or 429; test on one real account.

---

### 1.2 Chunk large PATCH bodies

**Problem:** Single patch may include thousands of `remove` / `append` entries; Cloudflare may reject oversized JSON.

**Implementation steps**

1. Add `GATEWAY_PATCH_CHUNK_SIZE` (default **500**, env-tunable).

2. Add `patchListInChunks(listId, { remove, append })`:
   - Split `remove` and `append` into chunks.
   - Apply sequentially per list (avoid concurrent patches on same `listId`).
   - Log: `list X: patch 2/5 (+200, -150)`.

3. Use in:
   - `lib/api.js` — sync and defragment
   - `menu.js` / `server.js` — custom allowlist PATCH paths

**Acceptance:** Full update with 200k+ domains completes without 413/400 payload errors.

---

### 1.3 Wirefilter rule size guard

**Problem:** `upsertZeroTrustDNSRule` builds one `any(...) or any(...)` expression per list. Very high list counts may hit expression limits.

**Implementation steps**

1. After `getZeroTrustLists`, compute expression length and list count.
2. If above safe threshold (determine empirically; warn when e.g. > 50 lists):
   - Log warning + document in README.
   - Suggest `CLOUDFLARE_LIST_ITEM_LIMIT`, defragment, or fewer sources.
3. **Defer** splitting into multiple rules unless you hit a real limit.

**Acceptance:** Rule create succeeds at your max list count; clear error message if not.

---

## Phase 2 — Performance (5–8 days)

**Purpose:** Faster updates without blowing rate limits. Sensible defaults for personal use; tunable for power users.

### 2.1 Shared concurrency utility

**New file:** `lib/concurrency.js`

```javascript
// runWithConcurrency(items, limit, async (item) => { ... })
// - limit from env CZGS_API_CONCURRENCY (default 3)
// - rely on fetchRetry for 429; do not ignore failures
// - optional progress callback
```

**Apply to:**

| Location | Parallelize | Suggested limit |
|----------|---------------|-----------------|
| `lib/api.js` | Fetch items per CZGS list | 3–5 |
| `lib/api.js` | Patch **different** list IDs | 2–3 |
| `lib/api.js` | Create new lists | 1–2 |
| `lib/utils.js` | `downloadFiles` URLs | 3–4 |
| Delete flows | `deleteZeroTrustListsOneByOne` | 2 |

**Keep sequential:** Multiple patches on the **same** `listId`.

**Acceptance:** Measurable sync time reduction; 429 rate not worse than today (recoverable retries OK).

---

### 2.2 Allowlist parent-domain index (`cf_list_create.js`)

**Problem:** Per blocklist line: `extractDomain(domain).slice(1)` + multiple `allowlist.has()` calls.

**Implementation steps**

1. After loading allowlist `Map`, build once:

   ```
   allowlistParents = new Set()
   for each domain in allowlist:
     for each parent in extractDomain(domain).slice(1):
       allowlistParents.add(parent)
   ```

2. In blocklist loop: use `allowlistParents.has(item)` for parent checks.
3. Keep `allowlist.has(domain)` for exact domain match.

**Acceptance:** Same `domains.length` and counter stats as before on a fixed file pair (compare logs once).

---

### 2.3 Skip no-op Cloudflare sync (incremental shortcut)

**Problem:** Every run refetches all list contents even when local files unchanged.

**Implementation steps**

1. Write manifest after processing files, e.g. `data/sync-manifest.json`:

   ```json
   {
     "blocklistSha256": "...",
     "allowlistSha256": "...",
     "domainCount": 123456,
     "generatedAt": "2026-05-18T12:00:00.000Z"
   }
   ```

2. If manifest unchanged since last **successful** sync → skip `synchronizeZeroTrustLists`; still run rule upsert if needed.

3. Force: `CZGS_FORCE_SYNC=1` or CLI `--force` (menu / web).

**Acceptance:** Second run with unchanged files completes in seconds.

**Caveat:** Manual Cloudflare list edits are not reconciled until force sync — document in README and troubleshooting.

---

### 2.4 SQLite bulk insert (`server.js`)

**Problem:** `insert.run()` per row inside transaction.

**Implementation steps**

1. Batch inserts (e.g. 500 rows per multi-value `INSERT OR IGNORE`).
2. Apply to traffic log sync and similar DNS analytics write loops.

**Acceptance:** 10k+ row sync measurably faster; data integrity unchanged.

---

### 2.5 Optional: faster file read

Only if profiling shows CPU-bound processing (unlikely vs API):

- Profile `cf_list_create.js` on your largest lists first.
- Consider single-pass pipeline only as part of Phase 4 refactor.

---

## Phase 3 — Observability and dashboard UX (2–4 days)

**Purpose:** Long runs feel reliable when shared with others.

### 3.1 Structured progress events

**Implementation steps**

1. Emit machine-readable progress from scripts / `lib/api.js`:

   ```
   [CZGS] phase=list-fetch progress=12/45
   [CZGS] phase=patch list="CZGS List - Chunk 3" additions=200 removals=50
   ```

2. `server.js` `runScript`: parse `[CZGS]` lines → Socket.IO `progress` events.

3. `public/script.js`: progress bar or step label on Quick Update tab.

**Acceptance:** Dashboard shows phase and fraction during update.

---

### 3.2 Timing summary

At end of list create / full refresh:

```
Download: 45s | Process: 120s | Sync: 380s | Rule: 2s | Total: 547s
```

Optional line in Discord webhook (`DISCORD_WEBHOOK_URL`).

---

### 3.3 Health endpoint (optional)

- `GET /api/health` → `{ ok, cloudflareConfigured, lastSync, dataDir }`
- Use in Docker `HEALTHCHECK`.

---

## Phase 4 — Maintainability refactor (1–2 weeks, incremental)

**Purpose:** Easier to patch and share. Start **after** Phases 1–2 stabilize behavior.

### 4.1 Split `server.js`

Suggested layout under `server/` or `lib/dashboard/`:

| Module | Responsibility |
|--------|----------------|
| `auth.js` | Basic auth, localhost bypass |
| `socket-handlers.js` | `run_update`, allowlist, URLs, rewrites |
| `traffic-map.js` | GraphQL sync, SQLite aggregates |
| `dns-analytics.js` | DNS analytics cache |
| `env-urls.js` | Read/write `ALLOWLIST_URLS` / `BLOCKLIST_URLS` |
| `gateway-custom.js` | Shared custom list/rule logic |

`server.js`: create app, static files, HTTP listen.

### 4.2 Extract shared Gateway custom logic

Move duplicates from `menu.js` + `server.js` into `lib/gateway-custom.js`:

- List/rule names, `findCustomAllowlist`, `upsertAllowRule`, paginated `fetchCustomListItems`, domain validation.

### 4.3 Centralize naming constants

`lib/czgs-names.js`:

- `GENERATED_LIST_PREFIX`, `GENERATED_RULE_PREFIX`, custom allow/deny names, etc.

**Acceptance:** No behavior change; menu and dashboard both work.

---

## Phase 5 — Share-ready packaging (2–3 days)

### 5.1 Personal-use vs remote defaults

| Scenario | `HOST` | `DASHBOARD_PASSWORD` | Notes |
|----------|--------|------------------------|-------|
| Laptop only | `127.0.0.1` | empty | Default safe |
| Home server / NAS | `0.0.0.0` | **required** | Docker Compose |
| Cloudflare Tunnel + Access | `127.0.0.1` | optional if Access protects | Document clearly |

### 5.2 Docker polish

- Docker Compose builds locally from source; do not document or depend on a maintainer-owned Docker Hub image.
- Healthcheck via `/api/health` (Phase 3).
- Document volumes: `CZGS_DATA_DIR`, `CZGS_ENV_PATH`.
- Example `docker-compose.override.yml` for bind-mounting data.

### 5.3 User / contributor docs

| File | Content |
|------|---------|
| `docs/ARCHITECTURE.md` | Pipeline diagram + file map |
| `docs/TROUBLESHOOTING.md` | 429, rule order, empty traffic map, force sync |
| `docs/CONFIGURATION.md` | All environment variables |

### 5.4 Sharing notice

- README: not affiliated with Cloudflare.
- API token minimum scopes checklist (Zero Trust Gateway read/edit).

---

## Phase 6 — Testing strategy (ongoing)

### 6.1 Unit tests (`node:test` or similar)

| Area | Functions |
|------|-----------|
| Domain utils | `normalizeDomain`, `isValidDomain`, `extractDomain` |
| Gateway custom | `parseDomains`, DNS rewrite parsing |
| Patch helper | `patchListInChunks` |
| Manifest | skip-unchanged sync logic |

### 6.2 Integration

- CI: `npm run dry` without Cloudflare credentials.
- Optional manual workflow with secrets for live API smoke test.

### 6.3 Manual checklist (`docs/TESTING.md`)

1. Fresh install: `.env`, `npm install`, `npm run web`.
2. Quick Update end-to-end.
3. Custom allowlist add/remove.
4. Full reset preserves custom allow resources.
5. Second run skips sync when files unchanged (`CZGS_FORCE_SYNC=0`).
6. Remote dashboard requires password.

---

## 11. Configuration reference (after improvements)

Add to `.env.default` and README:

| Variable | Default | Phase |
|----------|---------|-------|
| `CZGS_API_CONCURRENCY` | `3` | 2 |
| `CZGS_DOWNLOAD_CONCURRENCY` | `3` | 2 |
| `GATEWAY_PATCH_CHUNK_SIZE` | `500` | 1 |
| `CZGS_FORCE_SYNC` | `0` | 2 |
| `CZGS_SKIP_SYNC_IF_UNCHANGED` | `1` | 2 |

Existing variables (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, dashboard auth, traffic map, etc.) remain as documented in `README.md`.

---

## 12. Suggested timeline

| Week | Work |
|------|------|
| 1 | Phase 0 + Phase 1 (pagination, patch chunking) |
| 2 | Phase 2.1–2.3 (concurrency, allowlist index, manifest skip) |
| 3 | Phase 2.4 + Phase 3 (DB batch, progress UI) + start Phase 6 tests |
| 4+ | Phase 4 refactor + Phase 5 docs (as needed) |

**Minimum viable (≈1 week):** Phase 0 + 1 + 2.1 + 2.2  
**Best for sharers (≈3 weeks):** Through Phase 3 + 5 + basic Phase 6

---

## 13. Scope control (what not to do)

- Do not remove API throttling entirely; use bounded concurrency only.
- Do not rename Cloudflare lists/rules without a migration path.
- Do not commit `.env`, `allowlist.txt`, `blocklist.txt`, or `data/`.
- Do not rewrite the dashboard UI framework; add progress UX only.
- Do not change Puppeteer usage unless you verify it is still required.

---

## 14. Success metrics

| Metric | Target |
|--------|--------|
| Full refresh duration | Meaningfully faster (measure before/after Phase 2; aim 30–50% on large lists) |
| Repeat run, unchanged files | Under ~30 seconds (manifest skip) |
| Sync correctness | Processed domain count matches Cloudflare lists within known limits |
| 429 handling | No worse than today; recover via existing backoff |
| New user setup | README + `.env.default` → working dashboard in under 15 minutes |
| Remote security | Password required by default for non-localhost access |

---

## 15. Recommended implementation order

For coding sessions, use this order:

1. **Phase 1.1** — Paginated list items (correctness).
2. **Phase 1.2** — Patch chunking (correctness at scale).
3. **Phase 6** — Basic unit tests for pagination and patch helpers.
4. **Phase 2.2** — Allowlist parent-domain index (safe speed improvement).
5. **Phase 2.1** — Bounded concurrency (speed after correctness is stable).
6. **Phase 2.3** — Skip unchanged sync (daily-use speed).
7. **Phase 3.1** — Dashboard progress UI.
8. **Phase 4 + 5** — Refactor and share docs when behavior is stable.

---

## File touch map (quick reference)

| Phase | Primary files |
|-------|----------------|
| 0 | `README.md`, `.env.default`, `CHANGELOG.md` |
| 1 | `lib/api.js`, `lib/gateway-lists.js` (new), `menu.js`, `server.js` |
| 2 | `lib/concurrency.js` (new), `lib/api.js`, `lib/utils.js`, `cf_list_create.js`, `lib/sync-manifest.js` (new), `server.js` |
| 3 | `lib/api.js`, `server.js`, `public/script.js` |
| 4 | `server.js` → `server/*`, `lib/gateway-custom.js`, `lib/czgs-names.js` |
| 5 | `docs/*`, `docker-compose.yml`, `README.md` |
| 6 | `test/*` or `*.test.js`, `docs/TESTING.md` |

---

*This plan is maintained in the repository at `docs/IMPLEMENTATION_PLAN.md`.*
