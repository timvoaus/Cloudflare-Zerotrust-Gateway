#!/usr/bin/env node
/**
 * CZGS Interactive Menu
 * Provides a friendly terminal menu to manage Cloudflare Zero Trust Gateway Scripts.
 *
 * Run with:  node menu.js   OR   npm run menu
 */

import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

import dotenv from 'dotenv';
dotenv.config({ override: false });

import {
  getZeroTrustLists,
  getZeroTrustRules,
  deleteZeroTrustListsOneByOne,
  deleteZeroTrustRule,
  upsertZeroTrustRule,
  getZeroTrustListItemValues,
  patchExistingListChunked,
  defragmentZeroTrustLists,
  upsertZeroTrustDNSRule,
  upsertZeroTrustSNIRule,
} from "./lib/api.js";
import { requestGateway } from "./lib/helpers.js";
import {
  CUSTOM_ALLOWLIST_NAME,
  CUSTOM_ALLOW_RULE_NAME,
  GENERATED_RULE_NAME_PREFIX,
  RULE_ORDER_WARNING,
  isGeneratedListName,
  isGeneratedRuleName,
  isCustomAllowlistName,
  isCustomAllowRuleName,
  findCustomAllowlist,
  upsertAllowRule,
} from "./lib/server/custom-gateway.js";

// ─── ANSI colours ────────────────────────────────────────────────────────────
const C = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  cyan:    "\x1b[36m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  red:     "\x1b[31m",
  blue:    "\x1b[34m",
  white:   "\x1b[37m",
  bgBlue:  "\x1b[44m",
  bgRed:   "\x1b[41m",
};

const fmt = {
  info:  (m) => `${C.cyan}ℹ ${C.reset}${m}`,
  ok:    (m) => `${C.green}✔ ${C.reset}${m}`,
  warn:  (m) => `${C.yellow}⚠ ${C.reset}${m}`,
  err:   (m) => `${C.red}✖ ${C.reset}${m}`,
  step:  (m) => `${C.blue}→ ${C.reset}${m}`,
  bold:  (m) => `${C.bold}${m}${C.reset}`,
  title: (m) => `\n${C.bold}${C.cyan}[ ${m} ]${C.reset}\n`,
};

// ─── readline helpers ─────────────────────────────────────────────────────────
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));
const askConfirm = async (q) => {
  const a = await ask(`${C.yellow}${q} [y/N]${C.reset} `);
  return a.trim().toLowerCase() === "y";
};

// ─── Spawn a Node script, streaming its output ────────────────────────────────
const runScript = (scriptArgs, extraEnv = {}) =>
  new Promise((resolve, reject) => {
    // Strip list URL keys from the inherited env so child scripts re-read
    // them fresh from .env via dotenv.config(). Without this, dotenv won't
    // override values that are already set in process.env (the old values
    // loaded when the menu started), so changes saved to .env would be ignored.
    const { BLOCKLIST_URLS, ALLOWLIST_URLS, ...inheritedEnv } = process.env;
    const child = spawn("node", scriptArgs, {
      stdio: "inherit",
      env: { ...inheritedEnv, ...extraEnv },
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Script exited with code ${code}`));
    });
  });

// ─── Banner / Menu ────────────────────────────────────────────────────────────
// Banner width is kept in sync with the table W constant below.
// Defined here so printBanner can reference it.
const MENU_W = 62;

const printBanner = () => {
  const title = 'Cloudflare Gateway Pi-hole Scripts \u2014 Menu';
  const pad = Math.floor((MENU_W - title.length) / 2);
  const titleLine = ' '.repeat(pad) + title + ' '.repeat(MENU_W - pad - title.length);
  console.clear();
  console.log(`
${C.bold}${C.cyan}\u2554${'\u2550'.repeat(MENU_W)}\u2557
\u2551${titleLine}\u2551
\u255a${'\u2550'.repeat(MENU_W)}\u255d${C.reset}
`);
};

const printMenu = () => {
  // W = total inner width of the table
  // L = label column width (must fit "Manage Custom Allowlist" = 23 chars)
  // D = description column width
  // Row content formula: 1(sp) + 3(badge) + 1(sp) + L + 1(sp) + D + 1(sp) = 7+L+D = W
  const W = MENU_W;
  const L = 26;
  const D = W - 7 - L; // = 29
  const line = `${C.cyan}├${'─'.repeat(W)}┤${C.reset}`;
  const top  = `${C.cyan}┌${'─'.repeat(W)}┐${C.reset}`;
  const bot  = `${C.cyan}└${'─'.repeat(W)}┘${C.reset}`;
  const row = (key, label, desc, danger = false) => {
    const badge = danger
      ? `${C.bgRed}${C.white} ${key} ${C.reset}`
      : `${C.bgBlue}${C.white} ${key} ${C.reset}`;
    return `${C.cyan}│${C.reset} ${badge} ${C.bold}${label.padEnd(L)}${C.reset} ${desc.padEnd(D)} ${C.cyan}│${C.reset}`;
  };
  // Header inner string must be exactly W=62 chars:
  // "  #  " (5) + "Action".padEnd(L=26) (26) + " " (1) + "Description".padEnd(D=29) (29) + " " (1) = 62
  const header = `  #  ${'Action'.padEnd(L)} ${'Description'.padEnd(D)} `;
  console.log(top);
  console.log(`${C.cyan}│${C.reset}${C.bold}${C.white}${header}${C.reset}${C.cyan}│${C.reset}`);
  console.log(line);
  console.log(row('1', 'Update',                 'Re-download & push to CF'));
  console.log(row('2', 'Update List URLs',        'Edit block/allow URLs'));
  console.log(row('3', 'Manage Custom Allowlist', 'Manage CF allow domains'));
  console.log(line);
  console.log(row('4', 'Defragment Lists',        'Clean empty lists & optimize'));
  console.log(line);
  console.log(row('5', 'Full Reset',              'Delete all & start fresh', true));
  console.log(line);
  console.log(`${C.cyan}│${C.reset}  ${C.dim}0   Exit${' '.repeat(W - 10)}${C.reset}${C.cyan}│${C.reset}`);
  console.log(bot);
  console.log();
};


// ══════════════════════════════════════════════════════════════════════════════
// Option 1 — Update
// ══════════════════════════════════════════════════════════════════════════════
async function optionUpdate() {
  console.log(fmt.title("Update"));

  console.log(fmt.step("Downloading latest block / allow lists…"));
  await runScript(["download_lists.js"]);

  console.log(`\n${fmt.step("Syncing lists in Cloudflare Gateway…")}`);
  await runScript(["cf_list_create.js"]);

  console.log(`\n${fmt.step("Upserting gateway firewall rule…")}`);
  await runScript(["cf_gateway_rule_create.js"]);

  console.log(`\n${fmt.ok("Update complete!")}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Option 2 — Update List URLs in .env
// ══════════════════════════════════════════════════════════════════════════════
async function optionUpdateUrls() {
  console.log(fmt.title("Update List URLs"));

  const envPath = resolve("./.env");
  if (!existsSync(envPath)) {
    console.log(fmt.err(".env not found. Copy .env.example to .env first."));
    return;
  }

  let envContent = readFileSync(envPath, "utf8");

  const getCurrent = (key) => {
    const quotedMatch = envContent.match(
      new RegExp(`^(?:#\\s*)?${key}="([\\s\\S]*?)"`, "m")
    );
    if (quotedMatch) {
      return quotedMatch[1]
        .split("\n")
        .map((u) => u.trim())
        .filter(Boolean);
    }
    const singleMatch = envContent.match(
      new RegExp(`^(?:#\\s*)?${key}=(.+)$`, "m")
    );
    if (singleMatch) {
      return singleMatch[1]
        .trim()
        .split(/\\n/)
        .map((u) => u.trim())
        .filter(Boolean);
    }
    return [];
  };

  const setKey = (content, key, urls) => {
    const value = `"${urls.join("\n")}"`;
    const newLine = `${key}=${value}`;
    const quotedPattern = new RegExp(
      `^(?:#\\s*)?${key}="[\\s\\S]*?"`, "m"
    );
    const singlePattern = new RegExp(
      `^(?:#\\s*)?${key}=.*$`, "m"
    );
    if (quotedPattern.test(content)) return content.replace(quotedPattern, newLine);
    if (singlePattern.test(content)) return content.replace(singlePattern, newLine);
    return `${content}\n${newLine}`;
  };

  // ── Sub-menu for one key (Add / Remove) ──────────────────────────────────
  const manageUrls = async (label, key) => {
    while (true) {
      const urls = getCurrent(key);

      console.log(`\n${fmt.bold(`— ${label} —`)}`);
      console.log(fmt.info(`Current URLs (${urls.length > 0 ? urls.length : "using defaults"}):`));
      if (urls.length > 0) {
        urls.forEach((u, i) => console.log(`   ${C.dim}${String(i + 1).padStart(3)}.${C.reset} ${u}`));
      } else {
        console.log(`   ${C.dim}(no custom URLs set — recommended defaults will be used)${C.reset}`);
      }

      console.log(`
  ${C.bgBlue}${C.white} a ${C.reset}  ${C.bold}Add${C.reset}    — append URL(s)
  ${C.bgRed}${C.white} r ${C.reset}  ${C.bold}Remove${C.reset} — remove URL(s) by number
  ${C.dim}  b   Back${C.reset}`);

      const sub = (await ask(`${C.bold}  Choice [a/r/b]:${C.reset} `)).trim().toLowerCase();
      if (sub === "b" || sub === "") break;

      if (sub === "a") {
        // ── Add ──
        console.log(`\n${fmt.info("Enter URLs to add, one per line. Empty line to finish.")}`);
        const added = [];
        while (true) {
          const line = (await ask("  URL: ")).trim();
          if (!line) break;
          if (urls.includes(line)) {
            console.log(fmt.warn(`  Already in list — skipped.`));
          } else {
            added.push(line);
            console.log(`  ${C.green}+${C.reset} ${line}`);
          }
        }
        if (added.length === 0) {
          console.log(fmt.warn("Nothing added."));
        } else {
          envContent = setKey(envContent, key, [...urls, ...added]);
          writeFileSync(envPath, envContent, "utf8");
          console.log(fmt.ok(`Added ${added.length} URL(s) — .env saved.`));
        }

      } else if (sub === "r") {
        // ── Remove ──
        if (urls.length === 0) {
          console.log(fmt.warn("No URLs to remove."));
          continue;
        }
        console.log(`\n${fmt.info("Enter the NUMBER(S) to remove, separated by spaces or commas.")}`);
        console.log(`${C.dim}  Example: 1 3  or  2,4${C.reset}\n`);
        const raw = (await ask("  Numbers: ")).trim();
        if (!raw) { console.log(fmt.warn("Nothing entered.")); continue; }

        const indices = raw
          .split(/[\s,]+/)
          .map((n) => parseInt(n, 10) - 1)
          .filter((n) => !isNaN(n) && n >= 0 && n < urls.length);

        if (indices.length === 0) {
          console.log(fmt.warn("No valid numbers entered."));
          continue;
        }

        const toRemove = indices.map((i) => urls[i]);
        console.log(`\n${fmt.step(`Will remove ${toRemove.length} URL(s):`)}`);
        toRemove.forEach((u) => console.log(`   ${C.red}-${C.reset} ${u}`));

        if (!(await askConfirm("Confirm removal?"))) {
          console.log(fmt.warn("Aborted."));
          continue;
        }

        const remaining = urls.filter((_, i) => !indices.includes(i));
        envContent = setKey(envContent, key, remaining);
        writeFileSync(envPath, envContent, "utf8");
        console.log(fmt.ok(`Removed ${toRemove.length} URL(s) — .env saved.`));

      } else {
        console.log(fmt.warn("Invalid choice. Enter a, r, or b."));
      }
    }
  };

  // ── Top-level: pick Blocklist or Allowlist ────────────────────────────────
  while (true) {
    console.log(`
  ${C.bgBlue}${C.white} 1 ${C.reset}  ${C.bold}Blocklist URLs${C.reset}
  ${C.bgBlue}${C.white} 2 ${C.reset}  ${C.bold}Allowlist URLs${C.reset}
  ${C.dim}  b   Back${C.reset}`);

    const pick = (await ask(`${C.bold}  Choice [1/2/b]:${C.reset} `)).trim().toLowerCase();
    if (pick === "b" || pick === "") break;

    if (pick === "1") {
      await manageUrls("BLOCKLIST_URLS", "BLOCKLIST_URLS");
      if (await askConfirm("\nRun Update now to apply changes?")) await optionUpdate();
    } else if (pick === "2") {
      await manageUrls("ALLOWLIST_URLS", "ALLOWLIST_URLS");
      if (await askConfirm("\nRun Update now to apply changes?")) await optionUpdate();
    } else {
      console.log(fmt.warn("Invalid choice. Enter 1, 2, or b."));
    }
  }
}



// ══════════════════════════════════════════════════════════════════════════════
// Option 3 — Manage Custom Allowlist
// ══════════════════════════════════════════════════════════════════════════════
function printRuleOrderWarning() {
  console.log(`\n${fmt.warn(RULE_ORDER_WARNING)}`);
}

async function optionManageAllowlist() {
  console.log(fmt.title("Manage Custom Allowlist"));

  // 1. Check / create the list
  console.log(fmt.step(`Looking for "${CUSTOM_ALLOWLIST_NAME}" in Cloudflare…`));
  const { result: lists } = await getZeroTrustLists();
  let customList = findCustomAllowlist(lists);

  if (customList) {
    console.log(fmt.ok(`Found existing list (ID: ${customList.id}, ${customList.count ?? "?"} item(s))`));
  } else {
    console.log(fmt.warn(`List not found.`));
    if (!(await askConfirm(`Create "${CUSTOM_ALLOWLIST_NAME}" now?`))) {
      console.log(fmt.warn("Aborted."));
      return;
    }

    const created = await requestGateway("/lists", {
      method: "POST",
      body: JSON.stringify({
        name: CUSTOM_ALLOWLIST_NAME,
        type: "DOMAIN",
        description: "Custom allowlist managed by the dashboard",
        items: [],
      }),
    });

    if (!created?.result?.id) {
      console.log(fmt.err("Failed to create list. API response:"), JSON.stringify(created));
      return;
    }
    customList = created.result;
    console.log(fmt.ok(`Created "${CUSTOM_ALLOWLIST_NAME}" (ID: ${customList.id})`));
  }

  console.log(`\n${fmt.step(`Upserting allow rule "${CUSTOM_ALLOW_RULE_NAME}"…`)}`);
  const allowRuleAction = await upsertAllowRule(customList.id);
  console.log(fmt.ok(`${allowRuleAction === 'created' ? 'Created' : 'Updated'} allow rule.`));
  printRuleOrderWarning();

  // 2. Sub-menu: Add / Remove
  while (true) {
    console.log(`
  ${C.bgBlue}${C.white} a ${C.reset}  ${C.bold}Add${C.reset}    — allow domain(s)
  ${C.bgRed}${C.white} r ${C.reset}  ${C.bold}Remove${C.reset} — remove domain(s)
  ${C.dim}  b   Back${C.reset}`);

    const sub = (await ask(`${C.bold}  Choice [a/r/b]:${C.reset} `)).trim().toLowerCase();

    if (sub === "b" || sub === "") break;

    if (sub === "a") {
      await allowlistAdd(customList);
    } else if (sub === "r") {
      await allowlistRemove(customList);
    } else {
      console.log(fmt.warn("Invalid choice. Enter a, r, or b."));
    }
  }
}

// ── Parse raw input into an array of validated domains ───────────────────────
// Accepts: comma-separated, space-separated, or one-per-line input.
function parseDomains(raw) {
  return raw
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

const DOMAIN_RE = /^([a-z0-9-]+\.)+[a-z]{2,}$/;

// ── Fetch items currently in the custom list ──────────────────────────────────
async function fetchCustomListItems(listId) {
  return getZeroTrustListItemValues(listId);
}

// ── Add domains ───────────────────────────────────────────────────────────────
async function allowlistAdd(customList) {
  console.log(`\n${fmt.bold("— Add domains —")}`);
  console.log(fmt.info("Enter domains to allow, separated by spaces or commas."));
  console.log(`${C.dim}  Example: google.com, facebook.com youtube.com${C.reset}\n`);

  const raw = (await ask("  > ")).trim();

  if (!raw) {
    console.log(fmt.warn("Nothing entered."));
    return;
  }

  const candidates = parseDomains(raw);
  const valid = [];
  const invalid = [];

  for (const d of candidates) {
    if (DOMAIN_RE.test(d)) valid.push(d);
    else invalid.push(d);
  }

  if (invalid.length > 0) {
    console.log(fmt.warn(`Skipped ${invalid.length} invalid entry(s): ${invalid.join(", ")}`));
  }

  if (valid.length === 0) {
    console.log(fmt.warn("No valid domains to add."));
    return;
  }

  console.log(`\n${fmt.step(`Adding ${valid.length} domain(s):`)}`);
  valid.forEach((d) => console.log(`   ${C.green}+${C.reset} ${d}`));

  await patchExistingListChunked(customList.id, { append: valid.map((d) => ({ value: d })) }, CUSTOM_ALLOWLIST_NAME);

  console.log(fmt.ok(`${valid.length} domain(s) added successfully.`));
  console.log(`\n${fmt.step(`Upserting allow rule "${CUSTOM_ALLOW_RULE_NAME}"…`)}`);
  const addRuleAction = await upsertAllowRule(customList.id);
  console.log(fmt.ok(`${addRuleAction === 'created' ? 'Created' : 'Updated'} allow rule.`));
}

// ── Remove domains ────────────────────────────────────────────────────────────
async function allowlistRemove(customList) {
  console.log(`\n${fmt.bold("— Remove domains —")}`);
  console.log(fmt.step("Fetching current list items…"));

  const existing = await fetchCustomListItems(customList.id);

  if (existing.length === 0) {
    console.log(fmt.warn("The allowlist is empty — nothing to remove."));
    return;
  }

  console.log(fmt.info(`Current domains in "${CUSTOM_ALLOWLIST_NAME}" (${existing.length}):`));
  existing.forEach((d, i) => console.log(`   ${C.dim}${String(i + 1).padStart(3)}.${C.reset} ${d}`));

  console.log(`\n${fmt.info("Enter domains to REMOVE, separated by spaces or commas.")}`);
  console.log(`${C.dim}  Example: google.com, facebook.com youtube.com${C.reset}\n`);

  const raw = (await ask("  > ")).trim();

  if (!raw) {
    console.log(fmt.warn("Nothing entered."));
    return;
  }

  const candidates = parseDomains(raw);
  const existingSet = new Set(existing);
  const toRemove = [];
  const notFound = [];

  for (const d of candidates) {
    if (existingSet.has(d)) toRemove.push(d);
    else notFound.push(d);
  }

  if (notFound.length > 0) {
    console.log(fmt.warn(`Not in list (skipped): ${notFound.join(", ")}`));
  }

  if (toRemove.length === 0) {
    console.log(fmt.warn("No matching domains found to remove."));
    return;
  }

  console.log(`\n${fmt.step(`Removing ${toRemove.length} domain(s):`)}`);
  toRemove.forEach((d) => console.log(`   ${C.red}-${C.reset} ${d}`));

  if (!(await askConfirm("Confirm removal?"))) {
    console.log(fmt.warn("Aborted."));
    return;
  }

  await patchExistingListChunked(customList.id, { remove: toRemove }, CUSTOM_ALLOWLIST_NAME);

  console.log(fmt.ok(`${toRemove.length} domain(s) removed successfully.`));
  console.log(`\n${fmt.step(`Upserting allow rule "${CUSTOM_ALLOW_RULE_NAME}"…`)}`);
  const removeRuleAction = await upsertAllowRule(customList.id);
  console.log(fmt.ok(`${removeRuleAction === 'created' ? 'Created' : 'Updated'} allow rule.`));
}

// ══════════════════════════════════════════════════════════════════════════════
// Option 4 — Defragment Lists
// ══════════════════════════════════════════════════════════════════════════════
async function optionDefragment() {
  console.log(fmt.title("Defragment Lists"));
  console.log(fmt.info("This will optimize your CZGS lists by:"));
  console.log(fmt.info("  • Moving older domains to earlier lists"));
  console.log(fmt.info("  • Consolidating entries to minimize list count"));
  console.log(fmt.info("  • Deleting empty lists after updating the rule"));
  console.log();

  if (!(await askConfirm("Proceed with defragmentation?"))) {
    console.log(fmt.warn("Aborted."));
    return;
  }

  console.log(`\n${fmt.step("Starting defragmentation...")}`);
  const { emptyLists, nonEmptyLists, stats } = await defragmentZeroTrustLists();

  console.log(fmt.info(`Defragmented ${stats.chunks} lists → ${stats.assignedLists} lists`));
  console.log(fmt.info(`Moved ${stats.entriesToMove} entries across ${stats.patches} patches`));

  if (emptyLists.length > 0) {
    console.log(`\n${fmt.step("Updating rules to exclude empty lists...")}`);
    await upsertZeroTrustDNSRule(nonEmptyLists, "CZGS Filter Lists");
    console.log(fmt.ok(`Updated DNS rule using ${stats.nonEmptyLists} non-empty lists`));

    if (BLOCK_BASED_ON_SNI) {
      await upsertZeroTrustSNIRule(nonEmptyLists, "CZGS Filter Lists - SNI Based Filtering");
      console.log(fmt.ok("Updated SNI rule"));
    }

    console.log(`\n${fmt.step(`Deleting ${emptyLists.length} empty list(s)...`)}`);
    await deleteZeroTrustListsOneByOne(emptyLists);
    console.log(fmt.ok(`Deleted ${emptyLists.length} empty lists`));
  } else {
    console.log(fmt.info("No empty lists to clean up."));
  }

  console.log(`\n${fmt.ok("Defragmentation complete!")}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Option 5 — Full Reset
// ══════════════════════════════════════════════════════════════════════════════
async function optionFullReset() {
  console.log(fmt.title("Full Reset"));
  console.log(fmt.warn("This will DELETE generated CZGS block lists and block rules from Cloudflare,"));
  console.log(fmt.warn(`It will preserve "${CUSTOM_ALLOWLIST_NAME}" and "${CUSTOM_ALLOW_RULE_NAME}",`));
  console.log(fmt.warn("then perform a fresh download and push.\n"));

  if (!(await askConfirm("Are you SURE you want to do a full reset?"))) {
    console.log(fmt.warn("Aborted."));
    return;
  }

  // ── Delete rules ──
  console.log(`\n${fmt.step("Fetching existing gateway rules…")}`);
  const { result: rules } = await getZeroTrustRules();
  const czgsRules = (rules ?? []).filter(({ name }) => isGeneratedRuleName(name));

  if (czgsRules.length > 0) {
    console.log(fmt.step(`Deleting ${czgsRules.length} rule(s)…`));
    for (const rule of czgsRules) {
      await deleteZeroTrustRule(rule.id);
      console.log(fmt.ok(`  Deleted rule: ${rule.name}`));
    }
  } else {
    console.log(fmt.info("No CZGS rules found."));
  }

  // ── Delete lists ──
  console.log(`\n${fmt.step("Fetching existing gateway lists…")}`);
  const { result: lists } = await getZeroTrustLists();
  const czgsLists = (lists ?? []).filter(({ name }) => isGeneratedListName(name));

  if (czgsLists.length > 0) {
    console.log(fmt.step(`Deleting ${czgsLists.length} list(s)…`));
    await deleteZeroTrustListsOneByOne(czgsLists);
    console.log(fmt.ok("All CZGS lists deleted."));
  } else {
    console.log(fmt.info("No CZGS lists found."));
  }

  console.log(`\n${fmt.ok("Generated CZGS block resources are now clear. Custom allowlist resources were preserved.")}`);

  // ── Fresh run ──
  console.log(`\n${fmt.step("Downloading lists…")}`);
  await runScript(["download_lists.js"]);

  console.log(`\n${fmt.step("Creating lists in Cloudflare…")}`);
  await runScript(["cf_list_create.js"]);

  console.log(`\n${fmt.step("Creating gateway block rule…")}`);
  await runScript(["cf_gateway_rule_create.js"]);

  console.log(`\n${fmt.ok("Full reset complete! Everything is fresh and running.")}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Main loop
// ══════════════════════════════════════════════════════════════════════════════
async function main() {
  // Guard: credentials must be present
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    console.log(`\n${fmt.err("Missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID in .env")}`);
    console.log("Please copy .env.example to .env and fill in your Cloudflare credentials.\n");
    rl.close();
    process.exit(1);
  }

  while (true) {
    printBanner();
    printMenu();

    const choice = (await ask(`${C.bold}  Enter choice [0-5]:${C.reset} `)).trim();
    console.log();

    try {
      switch (choice) {
        case "1": await optionUpdate();          break;
        case "2": await optionUpdateUrls();      break;
        case "3": await optionManageAllowlist(); break;
        case "4": await optionDefragment();      break;
        case "5": await optionFullReset();       break;
        case "0":
          console.log(fmt.ok("Goodbye!\n"));
          rl.close();
          process.exit(0);
        default:
          console.log(fmt.warn("Invalid choice. Please enter 0–5."));
      }
    } catch (err) {
      console.log(`\n${fmt.err("An error occurred:")}`);
      console.error(`  ${C.red}${err.message}${C.reset}`);
    }

    await ask(`\n${C.dim}  Press Enter to return to the menu…${C.reset}`);
  }
}

main();
