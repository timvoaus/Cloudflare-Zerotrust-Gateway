import { deleteZeroTrustRule, getZeroTrustRules } from "./lib/api.js";
import { DELETION_ENABLED } from "./lib/constants.js";
import { notifyWebhook } from "./lib/utils.js";

if (!DELETION_ENABLED) {
  console.warn(
    "The rule deletion step is no longer needed to update filter lists, safely skipping. To proceed with deletion to e.g. stop using CZGS, set the environment variable CZGS_DELETION_ENABLED=true and re-run the script. Exiting."
  );
  process.exit(0);
}

const { result: rules } = await getZeroTrustRules();
const czgsRules = rules.filter(({ name }) => name.startsWith("CZGS Filter Lists"));

(async () => {
  if (!czgsRules.length) {
    console.warn(
      "No rule(s) with matching name found - this is not an issue if you haven't run the create script yet. Exiting."
    );
    return;
  }

  for (const czgsRule of czgsRules) {
    console.log(`Deleting rule ${czgsRule.name}...`);
    await deleteZeroTrustRule(czgsRule.id);
  }
})();

// Send a notification to the webhook
await notifyWebhook("CF Gateway Rule Delete script finished running");
