/**
 * Custom Gateway Allowlist/Denylist Module
 * Shared logic for custom allowlist and denylist operations between dashboard and CLI menu.
 */

import { getZeroTrustLists, getZeroTrustRules } from '../api.js';
import { requestGateway } from '../helpers.js';

// ══════════════════════════════════════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════════════════════════════════════

export const CUSTOM_ALLOWLIST_NAME = "Gateway Custom Allowlist";
export const CUSTOM_ALLOW_RULE_NAME = "Gateway Custom Allow Rule";
export const CUSTOM_DENYLIST_NAME = "Gateway Custom Denylist";
export const CUSTOM_DENY_RULE_NAME = "Gateway Custom Deny Rule";
export const GENERATED_LIST_NAME_PREFIX = "CZGS List";
export const GENERATED_RULE_NAME_PREFIX = "CZGS Filter Lists";

export const RULE_ORDER_WARNING = `IMPORTANT: In Cloudflare Zero Trust > Gateway > Firewall Policies > DNS, move "${CUSTOM_ALLOW_RULE_NAME}" above "${GENERATED_RULE_NAME_PREFIX}". Rules are evaluated top-to-bottom, so the custom allow rule must be first.`;

// ══════════════════════════════════════════════════════════════════════════════
// Helper Functions
// ══════════════════════════════════════════════════════════════════════════════

export function isGeneratedListName(name) {
  return name.startsWith(GENERATED_LIST_NAME_PREFIX);
}

export function isGeneratedRuleName(name) {
  return name.startsWith(GENERATED_RULE_NAME_PREFIX);
}

export function isCustomAllowlistName(name) {
  return name === CUSTOM_ALLOWLIST_NAME || (name.endsWith("Custom Allowlist") && !name.startsWith("CZGS"));
}

export function isCustomDenylistName(name) {
  return name === CUSTOM_DENYLIST_NAME || (name.endsWith("Custom Denylist") && !name.startsWith("CZGS"));
}

export function isCustomAllowRuleName(name) {
  return name === CUSTOM_ALLOW_RULE_NAME || (name.endsWith("Custom Allow Rule") && !name.startsWith("CZGS"));
}

export function isCustomDenyRuleName(name) {
  return name === CUSTOM_DENY_RULE_NAME || (name.endsWith("Custom Deny Rule") && !name.startsWith("CZGS"));
}

export function findCustomAllowlist(lists = []) {
  return lists.find(({ name }) => name === CUSTOM_ALLOWLIST_NAME)
    || lists.find(({ name }) => isCustomAllowlistName(name) && !isGeneratedListName(name));
}

export function findCustomDenylist(lists = []) {
  return lists.find(({ name }) => name === CUSTOM_DENYLIST_NAME)
    || lists.find(({ name }) => isCustomDenylistName(name) && !isGeneratedListName(name));
}

// ══════════════════════════════════════════════════════════════════════════════
// Rule Management
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Create or update the custom allow rule.
 * @returns {Promise<'created' | 'updated'>} Action performed
 */
export async function upsertAllowRule(listId) {
  const allowExpression = `any(dns.domains[*] in $${listId})`;
  const { result: existingRules } = await getZeroTrustRules();
  const existingAllowRule = existingRules?.find(({ name }) => name === CUSTOM_ALLOW_RULE_NAME)
    || existingRules?.find(({ name }) => isCustomAllowRuleName(name) && !isGeneratedRuleName(name));

  const rulePayload = {
    name: CUSTOM_ALLOW_RULE_NAME,
    description: `Custom allow list managed by the dashboard. Must be ordered above ${GENERATED_RULE_NAME_PREFIX}.`,
    enabled: true,
    action: "allow",
    filters: ["dns"],
    traffic: allowExpression,
  };

  if (existingAllowRule) {
    await requestGateway(`/rules/${existingAllowRule.id}`, {
      method: "PUT",
      body: JSON.stringify(rulePayload),
    });
    return "updated";
  } else {
    await requestGateway("/rules", {
      method: "POST",
      body: JSON.stringify(rulePayload),
    });
    return "created";
  }
}

/**
 * Create or update the custom deny rule.
 * @returns {Promise<'created' | 'updated'>} Action performed
 */
export async function upsertDenyRule(listId) {
  const denyExpression = `any(dns.domains[*] in $${listId})`;
  const { result: existingRules } = await getZeroTrustRules();
  const existingDenyRule = existingRules?.find(({ name }) => name === CUSTOM_DENY_RULE_NAME)
    || existingRules?.find(({ name }) => isCustomDenyRuleName(name) && !isGeneratedRuleName(name));

  const rulePayload = {
    name: CUSTOM_DENY_RULE_NAME,
    description: "Custom deny list managed by the dashboard.",
    enabled: true,
    action: "block",
    filters: ["dns"],
    traffic: denyExpression,
  };

  if (existingDenyRule) {
    await requestGateway(`/rules/${existingDenyRule.id}`, {
      method: "PUT",
      body: JSON.stringify(rulePayload),
    });
    return "updated";
  } else {
    await requestGateway("/rules", {
      method: "POST",
      body: JSON.stringify(rulePayload),
    });
    return "created";
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// List Management
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Find or create the custom allowlist.
 * @returns {Promise<Object>} The allowlist object
 */
export async function findOrCreateAllowlist() {
  const { result: lists } = await getZeroTrustLists();
  let customList = findCustomAllowlist(lists);

  if (!customList) {
    const created = await requestGateway("/lists", {
      method: "POST",
      body: JSON.stringify({
        name: CUSTOM_ALLOWLIST_NAME,
        type: "DOMAIN",
        description: "Custom allowlist managed by the dashboard",
        items: [],
      }),
    });
    if (!created?.result?.id) throw new Error("Failed to create allowlist.");
    customList = created.result;
  }

  return customList;
}

/**
 * Find or create the custom denylist.
 * @returns {Promise<Object>} The denylist object
 */
export async function findOrCreateDenylist() {
  const { result: lists } = await getZeroTrustLists();
  let customList = findCustomDenylist(lists);

  if (!customList) {
    const created = await requestGateway("/lists", {
      method: "POST",
      body: JSON.stringify({
        name: CUSTOM_DENYLIST_NAME,
        type: "DOMAIN",
        description: "Custom denylist managed by the dashboard",
        items: [],
      }),
    });
    if (!created?.result?.id) throw new Error("Failed to create denylist.");
    customList = created.result;
  }

  return customList;
}
