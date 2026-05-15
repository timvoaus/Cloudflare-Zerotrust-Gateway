import {
  deleteZeroTrustListsOneByOne,
  getZeroTrustLists,
} from "./lib/api.js";
import { DELETION_ENABLED } from "./lib/constants.js";
import { notifyWebhook } from "./lib/utils.js";

if (!DELETION_ENABLED) {
  console.warn(
    "The list deletion step is no longer needed to update filter lists, safely skipping. To proceed with deletion to e.g. stop using CZGS, set the environment variable CZGS_DELETION_ENABLED=true and re-run the script. Exiting."
  );
  process.exit(0);
}

(async () => {
  const { result: lists } = await getZeroTrustLists();

  if (!lists) {
    console.warn(
      "No file lists found - this is not an issue if it's your first time running this script. Exiting."
    );
    return;
  }

  const czgsLists = lists.filter(({ name }) => name.startsWith("CZGS List"));

  if (!czgsLists.length) {
    console.warn(
      "No lists with matching name found - this is not an issue if you haven't created any filter lists before. Exiting."
    );
    return;
  }

  console.log(
    `Got ${lists.length} lists, ${czgsLists.length} of which are CZGS lists that will be deleted.`
  );

  console.log(`Deleting ${czgsLists.length} lists...`);

  await deleteZeroTrustListsOneByOne(czgsLists);
  await notifyWebhook(`CF List Delete script finished running (${czgsLists.length} lists)`);
})();
