/**
 * Sync manifest utilities for skip-unchanged optimization.
 * Stores hashes of processed domains and config to detect when Cloudflare sync can be skipped.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { LIST_ITEM_LIMIT, USER_DEFINED_ALLOWLIST_URLS, USER_DEFINED_BLOCKLIST_URLS, RECOMMENDED_ALLOWLIST_URLS, RECOMMENDED_BLOCKLIST_URLS } from "./constants.js";

const MANIFEST_VERSION = 1;
const MANIFEST_PATH = join(process.cwd(), "data", "sync-manifest.json");

/**
 * Computes SHA-256 hash of sorted domain array.
 * @param {string[]} domains - Array of domain strings
 * @returns {string} - SHA-256 hash string
 */
export function computeDomainsHash(domains) {
  const sorted = [...domains].sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}

/**
 * Computes hash of URL sources.
 * @param {string[]|undefined} userUrls - User-defined URLs
 * @param {string[]} defaultUrls - Default recommended URLs
 * @returns {string} - SHA-256 hash string
 */
function computeSourceHash(userUrls, defaultUrls) {
  const urls = userUrls || defaultUrls;
  return createHash("sha256").update(urls.join("\n")).digest("hex");
}

/**
 * Loads existing manifest from disk.
 * @returns {Object|null} - Parsed manifest or null if not found/invalid
 */
export function loadManifest() {
  try {
    if (!existsSync(MANIFEST_PATH)) {
      return null;
    }
    const content = readFileSync(MANIFEST_PATH, "utf-8");
    return JSON.parse(content);
  } catch (err) {
    console.warn(`Failed to load manifest: ${err.message}`);
    return null;
  }
}

/**
 * Saves manifest to disk.
 * @param {Object} manifest - Manifest object to save
 */
export function saveManifest(manifest) {
  try {
    const dir = dirname(MANIFEST_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf-8");
  } catch (err) {
    console.warn(`Failed to save manifest: ${err.message}`);
  }
}

/**
 * Builds manifest from current state.
 * @param {string[]} domains - Processed blocklist domains
 * @param {Set<string>} allowlist - Processed allowlist domains
 * @returns {Object} - Manifest object
 */
export function buildManifest(domains, allowlist) {
  const allowlistArray = Array.from(allowlist.keys());
  
  return {
    version: MANIFEST_VERSION,
    blocklistDomainsHash: computeDomainsHash(domains),
    allowlistDomainsHash: computeDomainsHash(allowlistArray),
    listItemLimit: LIST_ITEM_LIMIT,
    allowlistSourceHash: computeSourceHash(USER_DEFINED_ALLOWLIST_URLS, RECOMMENDED_ALLOWLIST_URLS),
    blocklistSourceHash: computeSourceHash(USER_DEFINED_BLOCKLIST_URLS, RECOMMENDED_BLOCKLIST_URLS),
    domainCount: domains.length,
    allowlistCount: allowlistArray.length,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Checks if current state matches saved manifest.
 * @param {string[]} domains - Current processed domains
 * @param {Set<string>} allowlist - Current allowlist
 * @param {Object|null} savedManifest - Previously saved manifest
 * @returns {boolean} - True if unchanged and can skip sync
 */
export function isManifestUnchanged(domains, allowlist, savedManifest) {
  if (!savedManifest) {
    return false;
  }

  // Check version compatibility
  if (savedManifest.version !== MANIFEST_VERSION) {
    return false;
  }

  const current = buildManifest(domains, allowlist);

  // Compare all relevant fields
  const keysToCompare = [
    "blocklistDomainsHash",
    "allowlistDomainsHash",
    "listItemLimit",
    "allowlistSourceHash",
    "blocklistSourceHash",
  ];

  for (const key of keysToCompare) {
    if (current[key] !== savedManifest[key]) {
      return false;
    }
  }

  return true;
}

/**
 * Formats manifest change reason for logging.
 * @param {string[]} domains - Current domains
 * @param {Set<string>} allowlist - Current allowlist
 * @param {Object|null} savedManifest - Saved manifest
 * @returns {string} - Human-readable change description
 */
export function getManifestChangeReason(domains, allowlist, savedManifest) {
  if (!savedManifest) {
    return "No previous manifest found";
  }

  if (savedManifest.version !== MANIFEST_VERSION) {
    return `Manifest version mismatch (${savedManifest.version} vs ${MANIFEST_VERSION})`;
  }

  const current = buildManifest(domains, allowlist);
  const changes = [];

  if (current.blocklistDomainsHash !== savedManifest.blocklistDomainsHash) {
    changes.push("blocklist domains changed");
  }
  if (current.allowlistDomainsHash !== savedManifest.allowlistDomainsHash) {
    changes.push("allowlist domains changed");
  }
  if (current.listItemLimit !== savedManifest.listItemLimit) {
    changes.push(`LIST_ITEM_LIMIT changed (${savedManifest.listItemLimit} → ${current.listItemLimit})`);
  }
  if (current.allowlistSourceHash !== savedManifest.allowlistSourceHash) {
    changes.push("allowlist sources changed");
  }
  if (current.blocklistSourceHash !== savedManifest.blocklistSourceHash) {
    changes.push("blocklist sources changed");
  }

  if (changes.length === 0) {
    return "No changes detected (manifest unchanged)";
  }

  return changes.join("; ");
}
