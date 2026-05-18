/** Conservative thresholds — Cloudflare limits vary by plan.
 * User confirmed working: 300 lists, ~21,000+ chars.
 * Firewall Rules have a hard 4096 limit (different product).
 */
export const WIREFILTER_WARN_LIST_COUNT = 300;
export const WIREFILTER_WARN_EXPRESSION_LENGTH = 25000;

/**
 * Log warnings when a Gateway wirefilter expression may exceed platform limits.
 * @param {string} expression
 * @param {{ listCount: number, ruleLabel?: string }} options
 */
export function warnIfWirefilterExpressionLarge(expression, { listCount, ruleLabel = "DNS" }) {
  if (listCount >= WIREFILTER_WARN_LIST_COUNT) {
    console.warn(
      `WARNING: CZGS ${ruleLabel} rule references ${listCount} lists (threshold: ${WIREFILTER_WARN_LIST_COUNT}). ` +
        "If rule creation fails, reduce CLOUDFLARE_LIST_ITEM_LIMIT, run defragment, or use fewer blocklist sources."
    );
  }

  if (expression.length >= WIREFILTER_WARN_EXPRESSION_LENGTH) {
    console.warn(
      `WARNING: CZGS ${ruleLabel} wirefilter expression is ${expression.length} characters ` +
        `(warning threshold: ${WIREFILTER_WARN_EXPRESSION_LENGTH}). ` +
        `If rule upsert fails, run defragment to consolidate lists or reduce domain count.`
    );
  }
}
