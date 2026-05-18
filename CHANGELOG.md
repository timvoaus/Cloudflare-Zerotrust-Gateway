# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- Wirefilter expression size warnings before DNS/SNI rule upsert.
- Update timing summary in the dashboard Quick Update flow.
- Health endpoint fields: `dataDir`, `lastSync` (list sync + traffic map).
- `docs/TESTING.md` manual test checklist.
- README deploy scenarios table and typical update duration note.

### Changed

- Traffic log SQLite inserts use batched multi-row statements (500 rows per batch).

- Added Cloudflare GraphQL traffic-map aggregate sync for 24-hour traffic data.
- Added local SQLite traffic-map aggregate tables and daily snapshots for 7-day and 30-day ranges.
- Added `TRAFFIC_MAP_SYNC_COOLDOWN_SECONDS` to reduce repeated Cloudflare GraphQL API calls.

### Changed

- Updated traffic-map reads to prefer local aggregate data, with raw activity logs as fallback.
- Updated Docker deployment to build a local image from source instead of using a Docker Hub image.
- Cleaned up README documentation with combined project overview, screenshots, setup, environment variables, and deployment guidance.
