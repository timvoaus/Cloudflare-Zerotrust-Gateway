import { getZeroTrustLists, upsertZeroTrustDNSRule, upsertZeroTrustSNIRule } from "./lib/api.js";
import { BLOCK_BASED_ON_SNI } from "./lib/constants.js";
import { notifyWebhook } from "./lib/utils.js";

console.log(`CZGS_PROGRESS|phase=rule|current=0|total=1|message=Fetching Gateway lists...`);
const { result: lists } = await getZeroTrustLists();

// Upsert DNS rules for all lists
console.log(`CZGS_PROGRESS|phase=rule|current=0|total=1|message=Creating/updating DNS rule...`);
await upsertZeroTrustDNSRule(lists, "CZGS Filter Lists");
console.log(`CZGS_PROGRESS|phase=rule|current=1|total=1|message=DNS rule updated`);

// Optionally create a rule that matches the SNI.
// This only works for users who proxy their traffic through Cloudflare.
if (BLOCK_BASED_ON_SNI) {
  console.log(`CZGS_PROGRESS|phase=rule|current=1|total=2|message=Creating/updating SNI rule...`);
  await upsertZeroTrustSNIRule(lists, "CZGS Filter Lists - SNI Based Filtering");
  console.log(`CZGS_PROGRESS|phase=rule|current=2|total=2|message=SNI rule updated`);
}

// Send a notification to the webhook
console.log(`CZGS_PROGRESS|phase=complete|current=1|total=1|message=Gateway rules updated successfully`);
await notifyWebhook("CF Gateway Rule Create script finished running");
