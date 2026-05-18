/**
 * Dashboard Authentication module.
 * Handles Basic Auth, localhost bypass, and auth configuration.
 */

import { timingSafeEqual } from 'node:crypto';

// Environment-based auth configuration
export const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME || "admin";
export const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || process.env.CZGS_DASHBOARD_PASSWORD || "";
export const DASHBOARD_AUTH_DISABLED = process.env.DASHBOARD_AUTH_DISABLED === "1";
export const DASHBOARD_ALLOWED_ORIGINS = (process.env.DASHBOARD_ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

/**
 * Securely compare two strings using timing-safe equality.
 * Prevents timing attacks by ensuring comparison takes constant time.
 */
export function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * Parse Basic Auth credentials from request headers.
 * @returns {Object|null} {username, password} or null if not valid Basic Auth
 */
export function parseBasicAuth(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return null;

  try {
    const base64 = header.slice(6);
    const decoded = Buffer.from(base64, "base64").toString("utf8");
    const colonIndex = decoded.indexOf(":");

    if (colonIndex === -1) return null;

    return {
      username: decoded.slice(0, colonIndex),
      password: decoded.slice(colonIndex + 1),
    };
  } catch {
    return null;
  }
}

/**
 * Check if request is from localhost/loopback address.
 */
export function isLoopbackRequest(req) {
  const remoteAddress = req.socket?.remoteAddress || "";
  return remoteAddress === "::1" || remoteAddress === "127.0.0.1" || remoteAddress === "::ffff:127.0.0.1";
}

/**
 * Check if a dashboard request is authorized.
 * - If DASHBOARD_AUTH_DISABLED is set, always allow
 * - If no password is set, only allow localhost
 * - Otherwise, check Basic Auth credentials
 */
export function isDashboardRequestAuthorized(req) {
  if (DASHBOARD_AUTH_DISABLED) return true;

  if (!DASHBOARD_PASSWORD) {
    return isLoopbackRequest(req);
  }

  const credentials = parseBasicAuth(req);
  return !!credentials &&
    safeEqual(credentials.username, DASHBOARD_USERNAME) &&
    safeEqual(credentials.password, DASHBOARD_PASSWORD);
}

/**
 * Express middleware to require dashboard access.
 * Returns 401 with WWW-Authenticate header if password is set but not provided.
 * Returns 403 if no password is set and request is not from localhost.
 */
export function requireDashboardAccess(req, res, next) {
  if (isDashboardRequestAuthorized(req)) return next();

  if (DASHBOARD_PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="CZGS Dashboard", charset="UTF-8"');
    return res.status(401).send("Authentication required.");
  }

  return res.status(403).send(
    "Remote dashboard access is blocked by default. Set DASHBOARD_PASSWORD to enable authenticated remote access."
  );
}

/**
 * Socket.IO options with dashboard authorization.
 */
export function createSocketAuthOptions(corsOrigins = []) {
  const options = {
    allowRequest: (req, callback) => {
      if (isDashboardRequestAuthorized(req)) return callback(null, true);
      return callback("Unauthorized dashboard request", false);
    },
  };

  if (corsOrigins.length > 0) {
    options.cors = {
      origin: corsOrigins,
      methods: ["GET", "POST"],
      credentials: true,
    };
  }

  return options;
}

/**
 * Log security warning if remote access is blocked.
 */
export function logDashboardSecurityWarning() {
  if (!DASHBOARD_PASSWORD && !DASHBOARD_AUTH_DISABLED) {
    console.warn("Dashboard remote access is blocked until DASHBOARD_PASSWORD is set.");
  }
}
