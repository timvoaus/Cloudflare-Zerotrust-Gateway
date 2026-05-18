# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- Added Cloudflare GraphQL traffic-map aggregate sync for 24-hour traffic data.
- Added local SQLite traffic-map aggregate tables and daily snapshots for 7-day and 30-day ranges.
- Added `TRAFFIC_MAP_SYNC_COOLDOWN_SECONDS` to reduce repeated Cloudflare GraphQL API calls.

### Changed

- Updated traffic-map reads to prefer local aggregate data, with raw activity logs as fallback.
- Updated Docker deployment to build a local image from source instead of using a Docker Hub image.
- Cleaned up README documentation with combined project overview, screenshots, setup, environment variables, and deployment guidance.
