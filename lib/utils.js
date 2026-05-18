import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { CZGS_DOWNLOAD_CONCURRENCY, CLOUDFLARE_RATE_LIMITING_COOLDOWN_TIME, RATE_LIMITING_HTTP_ERROR_CODE } from "./constants.js";
import { runWithConcurrency } from "./concurrency.js";

/**
 * Checks if the value is a valid domain.
 * @param {string} value The value to be checked.
 */
export const isValidDomain = (value) =>
  /^\b((?=[a-z0-9-]{1,63}\.)(xn--)?[a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,63}\b$/.test(
    value
  );

/**
 * Extracts all subdomains from a domain including itself.
 * @param {string} domain The domain to be extracted.
 * @returns {string[]}
 */
export const extractDomain = (domain) => {
  const parts = domain.split(".");
  const extractedDomains = [];

  for (let i = 0; i < parts.length; i++) {
    const subdomains = parts.slice(i).join(".");

    extractedDomains.unshift(subdomains);
  }

  return extractedDomains;
};

/**
 * Checks if the value is a comment.
 * @param {string} value The value to be checked.
 */
export const isComment = (value) =>
  value.startsWith("#") ||
  value.startsWith("//") ||
  value.startsWith("!") ||
  value.startsWith("/*") ||
  value.startsWith("*/");

/**
 * Downloads files and concatenates them into one file.
 * Uses bounded concurrency to download in parallel, then writes sequentially.
 * @param {string} filePath The path to the file being written to.
 * @param {string[]} urls The URLs to the files to be downloaded.
 * @param {(completed: number, total: number) => void} [onProgress] Optional progress callback.
 */
export const downloadFiles = async (filePath, urls, onProgress) => {
  // Download with bounded concurrency, collecting responses in memory
  console.log(`Downloading ${urls.length} files with concurrency ${CZGS_DOWNLOAD_CONCURRENCY}...`);

  const responses = await runWithConcurrency(
    urls,
    async (url) => {
      const response = await fetchRetry(url);
      if (!response.ok) {
        throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
      }
      return response.text();
    },
    {
      concurrency: CZGS_DOWNLOAD_CONCURRENCY,
      onProgress: (completed, total) => {
        console.log(`  Downloaded ${completed}/${total} files...`);
        if (onProgress) {
          onProgress(completed, total);
        }
      },
    }
  );

  // Write sequentially to avoid race conditions on the same file
  const writeStream = createWriteStream(filePath, { flags: "w" });
  for (let i = 0; i < responses.length; i++) {
    writeStream.write(responses[i]);
    writeStream.write("\n");
  }
  writeStream.end();

  // Wait for write to complete
  await once(writeStream, "finish");
};

/**
 * @callback onLine
 * @param {string} line The current line.
 * @param {ReturnType<typeof createInterface>} rl The readline interface.
 */

/**
 * Asynchronously reads a file line by line.
 * @param {string} filePath The path to the file.
 * @param {onLine} onLine The callback executed on each line read.
 */
export const readFile = async (filePath, onLine) => {
  try {
    const rl = createInterface({
      input: createReadStream(filePath),
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => onLine(line, rl));

    await once(rl, "close");
  } catch (err) {
    console.error(
      `Error occurred while reading ${basename(filePath)} - ${err.toString()}`
    );
    throw err;
  }
};

/**
 * Memoizes a function
 * @template T The argument type of the function.
 * @template R The return type of the function.
 * @param {(...fnArgs: T[]) => R} fn The function to be memoized.
 */
export const memoize = (fn) => {
  const cache = new Map();

  return (...args) => {
    const key = args.join("-");

    if (cache.has(key)) return cache.get(key);

    const result = fn(...args);

    cache.set(key, result);
    return result;
  };
};

/**
 * Waits for a period of time
 * @param {number} ms The time to wait in milliseconds.
 */
export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends a message to a Discord-compatible webhook.
 * @param {url|string} url The webhook URL.
 * @param {string} message The message to be sent.
 * @returns {Promise}
 */
async function sendMessageToWebhook(url, message) {
  // Create the payload object with the message
  // The message is provided as 2 different properties to improve compatibility with webhook servers outside Discord
  const payload = { content: message, body: message };

  // Send a POST request to the webhook url with the payload as JSON
  try {
    const response = await fetchRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    return true;
  } catch (error) {
    console.error('Error sending message to webhook:', error);
    return false;
  }
}

/**
 * Sends a CZGS notification to a Discord-compatible webhook.
 * Automatically checks if the webhook URL exists.
 * @param {string} msg The message to be sent.
 * @returns {Promise}
 */
export async function notifyWebhook(msg) {
  // Check if the webhook URL exists
  const webhook_url = process.env.DISCORD_WEBHOOK_URL;

  if (webhook_url && webhook_url.startsWith('http')) {
    // Send the message to the webhook
    try {
      await sendMessageToWebhook(webhook_url, `CZGS: ${msg}`);
    } catch (e) {
      console.error('Error sending message to Discord webhook:', e);
    }
  }
  // Not logging the lack of a webhook URL since it's not a feature everyone would use
}

/**
 * Fetches with retry
 * @param  {Parameters<typeof fetch>} args
 */
export const fetchRetry = async (...args) => {
  let attempts = 0;
  const maxAttempts = 50;
  let response;

  while (attempts < maxAttempts) {
    try {
      response = await fetch(...args);

      if (response.ok) {
        return response;
      }

      const status = response.status;
      // Retry on rate limit or server errors
      if (status === RATE_LIMITING_HTTP_ERROR_CODE || (status >= 500 && status <= 504)) {
        throw new Error(`HTTP error! Status: ${status}`);
      }

      // For other errors (4xx), return the response and let the caller handle it
      return response;
    } catch (error) {
      attempts++;
      const status = response?.status;
      const isRateLimit = status === RATE_LIMITING_HTTP_ERROR_CODE;

      console.warn(
        `An error occurred while making a web request: "${error.message}", retrying. Attempt ${attempts} of ${maxAttempts}.\n` +
        (isRateLimit ? "Rate limit hit. " : "") +
        "THIS IS NORMAL IN MOST CIRCUMSTANCES. Refrain from reporting this as a bug unless the script doesn't automatically recover after several attempts."
      );

      if (attempts >= maxAttempts) {
        // Send a message to the Discord webhook if it exists
        await notifyWebhook(`An HTTP error has occurred (${status || "unknown status"}) while making a web request. Please check the logs for further details.`);
        throw error;
      }

      if (isRateLimit) {
        console.log(`Waiting for ${CLOUDFLARE_RATE_LIMITING_COOLDOWN_TIME / 1000 / 60} minutes to avoid rate limiting.`);
        await wait(CLOUDFLARE_RATE_LIMITING_COOLDOWN_TIME);
      } else {
        // Exponential backoff or simple wait for other errors?
        // Let's stick to a short wait for non-rate-limit retries
        await wait(2000 * attempts);
      }
    }
  }
};
