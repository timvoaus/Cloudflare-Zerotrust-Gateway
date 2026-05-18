/**
 * DNS Rewrite Module
 * Manages DNS rewrite rules for custom domain-to-IP mappings.
 */

import { isIP } from 'node:net';
import { requestGateway } from '../helpers.js';

// Constants
export const DNS_REWRITE_RULE_PREFIX = "Gateway DNS Rewrite - ";
export const DNS_REWRITE_RULE_DESCRIPTION = "DNS rewrite managed by the dashboard. Avoid editing this rule name.";

/**
 * Check if a rule name is a DNS rewrite rule.
 */
export function isDnsRewriteRuleName(name) {
  return name.startsWith(DNS_REWRITE_RULE_PREFIX);
}

/**
 * Normalize a rewrite domain (lowercase, trim, remove trailing dot).
 */
export function normalizeRewriteDomain(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
}

/**
 * Escape a string for use in Wirefilter expressions.
 */
export function escapeWirefilterString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Validate if a string is a valid rewrite domain.
 */
export function isValidRewriteDomain(value) {
  const DOMAIN_RE = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  return DOMAIN_RE.test(value);
}

/**
 * Parse rewrite configuration lines.
 * Format: domain.com 1.2.3.4,5.6.7.8 or domain.com -> 1.2.3.4
 * @returns {Object} { entries: [{domain, ips}], invalid: [{line, value, reason}] }
 */
export function parseRewriteLines(raw) {
  const entries = [];
  const invalid = [];
  const lines = String(raw || "").split(/\r?\n/);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const normalizedLine = trimmed
      .replace(/\s*->\s*/, " ")
      .replace(/\s*=\s*/, " ")
      .replace(/\s+/g, " ");
    const [domainValue, ...ipValues] = normalizedLine.split(/[,\s]+/).filter(Boolean);
    const domain = normalizeRewriteDomain(domainValue);
    const ips = [...new Set(ipValues.map(ip => ip.trim()).filter(Boolean))];

    if (!isValidRewriteDomain(domain)) {
      invalid.push({ line: index + 1, value: trimmed, reason: "Invalid domain" });
      return;
    }

    if (ips.length === 0 || ips.some(ip => isIP(ip) === 0)) {
      invalid.push({ line: index + 1, value: trimmed, reason: "Invalid IP address" });
      return;
    }

    entries.push({ domain, ips });
  });

  const byDomain = new Map();
  for (const entry of entries) {
    byDomain.set(entry.domain, entry);
  }

  return { entries: [...byDomain.values()], invalid };
}

/**
 * Extract the domain from a DNS rewrite rule.
 */
export function getRewriteDomainFromRule(rule) {
  if (rule.name?.startsWith(DNS_REWRITE_RULE_PREFIX)) {
    return normalizeRewriteDomain(rule.name.slice(DNS_REWRITE_RULE_PREFIX.length));
  }

  const match = String(rule.traffic || "").match(/dns\.fqdn\s*==\s*"((?:\\"|[^"])*)"/);
  return match ? normalizeRewriteDomain(match[1].replace(/\\"/g, '"')) : "";
}

/**
 * Get the override IPs from a DNS rewrite rule.
 */
export function getRewriteIpsFromRule(rule) {
  return Array.isArray(rule.rule_settings?.override_ips) ? rule.rule_settings.override_ips : [];
}

/**
 * Create or update a DNS rewrite rule.
 * @returns {Promise<'created' | 'updated'>}
 */
export async function upsertDnsRewriteRule({ domain, ips }, existingRule) {
  const rulePayload = {
    name: `${DNS_REWRITE_RULE_PREFIX}${domain}`,
    description: DNS_REWRITE_RULE_DESCRIPTION,
    enabled: true,
    action: "override",
    filters: ["dns"],
    traffic: `dns.fqdn == "${escapeWirefilterString(domain)}"`,
    rule_settings: {
      override_ips: ips,
    },
  };

  if (existingRule) {
    await requestGateway(`/rules/${existingRule.id}`, {
      method: "PUT",
      body: JSON.stringify(rulePayload),
    });
    return "updated";
  }

  await requestGateway("/rules", {
    method: "POST",
    body: JSON.stringify(rulePayload),
  });
  return "created";
}

/**
 * Serialize a DNS rewrite rule for the dashboard.
 */
export function serializeDnsRewriteRule(rule) {
  return {
    id: rule.id,
    name: rule.name,
    domain: getRewriteDomainFromRule(rule),
    ips: getRewriteIpsFromRule(rule),
    enabled: rule.enabled !== false,
  };
}
