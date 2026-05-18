import dotenv from 'dotenv';
import { getEnvPath } from './env.js';

dotenv.config({ path: getEnvPath(), override: false });

// Constants for the Cloudflare Zerotrust Gateway Scripts

if (process.env.CLOUDFLARE_API_KEY) {
  console.warn(
    "Using Global API Key is very risky for your Cloudflare account. It is strongly recommended to create an API Token with scoped permissions instead."
  );
}

export const API_KEY = process.env.CLOUDFLARE_API_KEY;

export const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

export const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;

export const ACCOUNT_EMAIL = process.env.CLOUDFLARE_ACCOUNT_EMAIL;

export const LIST_ITEM_LIMIT = isNaN(process.env.CLOUDFLARE_LIST_ITEM_LIMIT)
  ? 300000
  : parseInt(process.env.CLOUDFLARE_LIST_ITEM_LIMIT, 10);

export const LIST_ITEM_SIZE = 1000;

export const GATEWAY_PATCH_CHUNK_SIZE = isNaN(process.env.GATEWAY_PATCH_CHUNK_SIZE)
  ? 500
  : parseInt(process.env.GATEWAY_PATCH_CHUNK_SIZE, 10);

export const CZGS_API_CONCURRENCY = isNaN(process.env.CZGS_API_CONCURRENCY)
  ? 3
  : parseInt(process.env.CZGS_API_CONCURRENCY, 10);

export const CZGS_DOWNLOAD_CONCURRENCY = isNaN(process.env.CZGS_DOWNLOAD_CONCURRENCY)
  ? 3
  : parseInt(process.env.CZGS_DOWNLOAD_CONCURRENCY, 10);

export const CZGS_SKIP_SYNC_IF_UNCHANGED = parseInt(process.env.CZGS_SKIP_SYNC_IF_UNCHANGED, 10) !== 0;

export const CZGS_FORCE_SYNC = !!parseInt(process.env.CZGS_FORCE_SYNC, 10);

export const CZGS_AUTO_DEFRAGMENT = parseInt(process.env.CZGS_AUTO_DEFRAGMENT, 10) !== 0;

export const API_HOST = "https://api.cloudflare.com/client/v4";

export const DRY_RUN = !!parseInt(process.env.DRY_RUN, 10);

export const DELETION_ENABLED = !!process.env.CZGS_DELETION_ENABLED;

export const BLOCK_PAGE_ENABLED = !!parseInt(process.env.BLOCK_PAGE_ENABLED, 10);

export const BLOCK_BASED_ON_SNI = !!parseInt(process.env.BLOCK_BASED_ON_SNI, 10);

export const DEBUG = !!parseInt(process.env.DEBUG, 10);

export const CLOUDFLARE_RATE_LIMITING_COOLDOWN_TIME = 2 * 60 * 1000;
export const RATE_LIMITING_HTTP_ERROR_CODE = 429;

export const PROCESSING_FILENAME = {
  ALLOWLIST: "allowlist.txt",
  BLOCKLIST: "blocklist.txt",
  OLD_ALLOWLIST: "whitelist.csv",
  OLD_BLOCKLIST: "input.csv",
};

export const LIST_TYPE = {
  ALLOWLIST: "allowlist",
  BLOCKLIST: "blocklist",
};

export const USER_DEFINED_ALLOWLIST_URLS = process.env.ALLOWLIST_URLS
  ? process.env.ALLOWLIST_URLS.split("\n").filter((x) => x)
  : undefined;

export const USER_DEFINED_BLOCKLIST_URLS = process.env.BLOCKLIST_URLS
  ? process.env.BLOCKLIST_URLS.split("\n").filter((x) => x)
  : undefined;

// These are the default blocklists and allowlists that are used by the script if the user doesn't provide any URLs by themselves.
// The files are dynamically fetched from the internet, therefore it's important to choose only the most reliable sources.
// Commented out lists are subject to removal.

// You can have an unlimited number of allowlists, unlike blocklists.
export const RECOMMENDED_ALLOWLIST_URLS = [
  "https://adguardteam.github.io/HostlistsRegistry/assets/filter_45.txt",
  "https://raw.githubusercontent.com/AdguardTeam/HttpsExclusions/master/exclusions/banks.txt",
  "https://raw.githubusercontent.com/Dogino/Discord-Phishing-URLs/main/official-domains.txt",
  "https://raw.githubusercontent.com/AdguardTeam/HttpsExclusions/master/exclusions/mac.txt",
  "https://raw.githubusercontent.com/AdguardTeam/HttpsExclusions/master/exclusions/windows.txt",
  "https://raw.githubusercontent.com/boutetnico/url-shorteners/master/list.txt",
  "https://raw.githubusercontent.com/AdguardTeam/HttpsExclusions/master/exclusions/firefox.txt",
  "https://raw.githubusercontent.com/AdguardTeam/HttpsExclusions/master/exclusions/android.txt",
  "https://raw.githubusercontent.com/TogoFire-Home/AD-Settings/main/Filters/whitelist.txt",
  "https://raw.githubusercontent.com/DandelionSprout/AdGuard-Home-Whitelist/master/whitelist.txt",
  "https://raw.githubusercontent.com/AdguardTeam/AdGuardSDNSFilter/master/Filters/exclusions.txt",
  "https://raw.githubusercontent.com/AdguardTeam/HttpsExclusions/master/exclusions/issues.txt",
];

// The default blocklist settings are optimized for performance while still blocking a lot.
export const RECOMMENDED_BLOCKLIST_URLS = [
  "https://raw.githubusercontent.com/bigdargon/hostsVN/master/filters/adservers-all.txt",
  "https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt",
  "https://adguardteam.github.io/HostlistsRegistry/assets/filter_5.txt",
  "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/multi-onlydomains.txt",
  "https://adguardteam.github.io/HostlistsRegistry/assets/filter_16.txt",
];
