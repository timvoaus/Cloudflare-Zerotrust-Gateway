import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { synchronizeZeroTrustLists, getZeroTrustLists } from "./lib/api.js";
import { isGeneratedListName } from "./lib/server/custom-gateway.js";
import {
  DEBUG,
  DRY_RUN,
  CZGS_SKIP_SYNC_IF_UNCHANGED,
  CZGS_FORCE_SYNC,
  LIST_ITEM_LIMIT,
  LIST_ITEM_SIZE,
  PROCESSING_FILENAME,
} from "./lib/constants.js";
import {
  loadManifest,
  saveManifest,
  buildManifest,
  isManifestUnchanged,
  getManifestChangeReason,
} from "./lib/sync-manifest.js";
import { normalizeDomain } from "./lib/helpers.js";
import {
  extractDomain,
  isComment,
  isValidDomain,
  memoize,
  notifyWebhook,
  readFile,
} from "./lib/utils.js";

const allowlistFilename = existsSync(PROCESSING_FILENAME.OLD_ALLOWLIST)
  ? PROCESSING_FILENAME.OLD_ALLOWLIST
  : PROCESSING_FILENAME.ALLOWLIST;
const blocklistFilename = existsSync(PROCESSING_FILENAME.OLD_BLOCKLIST)
  ? PROCESSING_FILENAME.OLD_BLOCKLIST
  : PROCESSING_FILENAME.BLOCKLIST;
const allowlist = new Map();
const allowlistParents = new Set();
const blocklist = new Map();
const domains = [];
let processedDomainCount = 0;
let unnecessaryDomainCount = 0;
let duplicateDomainCount = 0;
let allowedDomainCount = 0;
const memoizedNormalizeDomain = memoize(normalizeDomain);

// Check if the blocklist.txt and allowlist.txt files exist
for (const filename of [allowlistFilename, blocklistFilename]) {
  if (!existsSync(filename)) {
    console.error(`File not found: ${filename}. Please create a block/allowlist first, or run download_lists.js to download the recommended lists.`);
    process.exit(1);
  }
}

// Read allowlist
console.log(`Processing ${allowlistFilename}`);
await readFile(resolve(`./${allowlistFilename}`), (line) => {
  const _line = line.trim();

  if (!_line) return;

  if (isComment(_line)) return;

  const domain = memoizedNormalizeDomain(_line, true);

  if (!isValidDomain(domain)) return;

  allowlist.set(domain, 1);

  // Precompute parent domains for allowlist index
  for (const parent of extractDomain(domain).slice(1)) {
    allowlistParents.add(parent);
  }
});

// Read blocklist
console.log(`Processing ${blocklistFilename}`);
console.log(`CZGS_PROGRESS|phase=process|current=0|total=${LIST_ITEM_LIMIT}|message=Processing ${blocklistFilename}...`);
let lastProgress = 0;
const progressInterval = 10000; // Emit progress every 10k domains

await readFile(resolve(`./${blocklistFilename}`), (line, rl) => {
  if (domains.length === LIST_ITEM_LIMIT) {
    return;
  }

  const _line = line.trim();

  if (!_line) return;

  // Check if the current line is a comment in any format
  if (isComment(_line)) return;

  // Remove prefixes and suffixes in hosts, wildcard or adblock format
  const domain = memoizedNormalizeDomain(_line);

  // Check if it is a valid domain which is not a URL or does not contain
  // characters like * in the middle of the domain
  if (!isValidDomain(domain)) return;

  processedDomainCount++;

  if (allowlist.has(domain)) {
    if (DEBUG) console.log(`Found ${domain} in allowlist - Skipping`);
    allowedDomainCount++;
    return;
  }

  if (blocklist.has(domain)) {
    if (DEBUG) console.log(`Found ${domain} in blocklist already - Skipping`);
    duplicateDomainCount++;
    return;
  }

  // Get all the levels of the domain and check from the highest
  // because we are blocking all subdomains
  // Example: fourth.third.example.com => ["example.com", "third.example.com", "fourth.third.example.com"]
  for (const item of extractDomain(domain).slice(1)) {
    // Check for any higher level domain matches in the allowlist using precomputed index
    if (allowlistParents.has(item)) {
      if (DEBUG) console.log(`Found parent domain ${item} in allowlist - Skipping ${domain}`);
      allowedDomainCount++;
      return;
    }

    if (!blocklist.has(item)) continue;

    // The higher-level domain is already blocked
    // so it's not necessary to block this domain
    if (DEBUG) console.log(`Found ${item} in blocklist already - Skipping ${domain}`);
    unnecessaryDomainCount++;
    return;
  }

  blocklist.set(domain, 1);
  domains.push(domain);

  // Emit progress periodically
  if (domains.length - lastProgress >= progressInterval) {
    console.log(`CZGS_PROGRESS|phase=process|current=${domains.length}|total=${LIST_ITEM_LIMIT}|message=Processed ${domains.length} domains...`);
    lastProgress = domains.length;
  }

  if (domains.length === LIST_ITEM_LIMIT) {
    console.log(
      "Maximum number of blocked domains reached - Stopping processing blocklist..."
    );
    rl.close();
  }
});

console.log(`CZGS_PROGRESS|phase=process|current=${domains.length}|total=${LIST_ITEM_LIMIT}|message=Processing complete - ${domains.length} domains`);

const numberOfLists = Math.ceil(domains.length / LIST_ITEM_SIZE);

console.log("\n\n");
console.log(`Number of processed domains: ${processedDomainCount}`);
console.log(`Number of duplicate domains: ${duplicateDomainCount}`);
console.log(`Number of unnecessary domains: ${unnecessaryDomainCount}`);
console.log(`Number of allowed domains: ${allowedDomainCount}`);
console.log(`Number of blocked domains: ${domains.length}`);
console.log(`Number of lists to be created: ${numberOfLists}`);
console.log("\n\n");

(async () => {
  if (DRY_RUN) {
    console.log(
      "Dry run complete - no lists were created. If this was not intended, please remove the DRY_RUN environment variable and try again."
    );
    return;
  }

  // Check if CZGS lists exist on Cloudflare (needed after Full Reset)
  console.log("Checking existing Cloudflare Gateway lists...");
  const { result: existingLists } = await getZeroTrustLists();
  const czgsLists = existingLists?.filter(({ name }) => isGeneratedListName(name)) || [];
  const czgsListsExist = czgsLists.length > 0;

  // Check manifest for skip-unchanged optimization
  const savedManifest = loadManifest();
  const manifestChanged = !isManifestUnchanged(domains, allowlist, savedManifest);
  const changeReason = getManifestChangeReason(domains, allowlist, savedManifest);

  if (CZGS_FORCE_SYNC) {
    console.log("CZGS_FORCE_SYNC is set - performing full sync regardless of manifest");
  } else if (CZGS_SKIP_SYNC_IF_UNCHANGED && !manifestChanged && czgsListsExist) {
    console.log("Manifest unchanged - skipping Cloudflare list sync (use CZGS_FORCE_SYNC=1 to override)");
    console.log(`  Previous sync: ${savedManifest?.generatedAt || "unknown"}`);
    console.log(`  Domains: ${domains.length}, Allowlist: ${allowlist.size}`);
    console.log(`  CZGS lists on Cloudflare: ${czgsLists.length}`);
    console.log(`CZGS_PROGRESS|phase=sync|current=0|total=1|message=No changes - sync skipped`);

    // Still save manifest to update timestamp
    const manifest = buildManifest(domains, allowlist);
    saveManifest(manifest);

    await notifyWebhook(
      `CF List Create skipped - no changes detected (${domains.length} domains)`
    );
    return;
  } else if (!czgsListsExist) {
    console.log(`No CZGS lists found on Cloudflare. Full sync required.`);
  } else {
    console.log(`Sync required: ${changeReason}`);
  }
  
  console.log(`CZGS_PROGRESS|phase=sync|current=0|total=${numberOfLists}|message=Starting Cloudflare sync...`);

  console.log(
    `Creating ${numberOfLists} lists for ${domains.length} domains...`
  );

  try {
    await synchronizeZeroTrustLists(domains);
    
    console.log(`CZGS_PROGRESS|phase=sync|current=${numberOfLists}|total=${numberOfLists}|message=Sync complete`);
    
    // Save manifest only after successful sync
    const manifest = buildManifest(domains, allowlist);
    saveManifest(manifest);
    console.log(`Manifest saved for ${domains.length} domains`);
    
    await notifyWebhook(
      `CF List Create script finished running (${domains.length} domains, ${numberOfLists} lists)`
    );
  } catch (err) {
    console.error(`Sync failed: ${err.message}`);
    console.error("Manifest not updated - next run will retry sync");
    console.log(`CZGS_PROGRESS|phase=error|current=0|total=1|message=Sync failed: ${err.message}`);
    throw err;
  }
})();
