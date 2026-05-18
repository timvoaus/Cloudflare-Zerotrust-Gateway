/**
 * Gateway Location Module
 * Manages Cloudflare Gateway location settings, particularly IPv4 configuration.
 */

// Environment-based location ID (no default - must be set or auto-detected)
export const GATEWAY_LOCATION_ID = process.env.CLOUDFLARE_GATEWAY_LOCATION_ID;

/**
 * Auto-detect the default Gateway Location ID from Cloudflare API.
 * Returns the location with client_default: true, or the first location if none is default.
 * @param {string} accountId - Cloudflare Account ID
 * @param {string} apiToken - Cloudflare API Token
 * @returns {Promise<string|null>} - Location ID or null if failed
 */
export async function detectGatewayLocationId(accountId, apiToken) {
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/gateway/locations`,
      {
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    if (!data.success || !Array.isArray(data.result)) {
      throw new Error('Invalid response from Cloudflare API');
    }

    const locations = data.result;

    if (locations.length === 0) {
      throw new Error('No Gateway locations found in account');
    }

    // Find the default location (client_default: true)
    const defaultLocation = locations.find(loc => loc.client_default === true);

    if (defaultLocation) {
      return defaultLocation.id;
    }

    // Fallback to first location if no default is set
    return locations[0].id;
  } catch (error) {
    console.error('Failed to auto-detect Gateway Location ID:', error.message);
    return null;
  }
}

/**
 * Get the primary IPv4 network from a location.
 */
export function getPrimaryIpv4Network(location) {
  return Array.isArray(location?.networks) && location.networks.length > 0
    ? location.networks[0]?.network || ""
    : "";
}

/**
 * Get DNS endpoint value with enabled flag.
 */
export function getDnsEndpointValue(enabled, value) {
  return {
    enabled: enabled !== false && Boolean(value),
    value: value || "",
  };
}

/**
 * Pick specific fields from an endpoint object.
 */
export function pickEndpointFields(endpoint = {}, allowedFields = []) {
  const picked = {};
  for (const field of allowedFields) {
    if (endpoint[field] !== undefined) picked[field] = endpoint[field];
  }
  return picked;
}

/**
 * Build the update payload for a Gateway location.
 */
export function buildGatewayLocationUpdatePayload(location, network) {
  const endpoints = location.endpoints || {};
  const payload = {
    name: location.name,
    networks: [{ network }],
  };

  if (location.client_default !== undefined) payload.client_default = location.client_default;
  if (location.dns_destination_ips_id !== undefined) payload.dns_destination_ips_id = location.dns_destination_ips_id;
  if (location.ecs_support !== undefined) payload.ecs_support = location.ecs_support;
  if (location.dns_destination_ipv6_block_id) {
    payload.dns_destination_ipv6_block_id = location.dns_destination_ipv6_block_id;
  }

  const sanitizedEndpoints = {};
  if (endpoints.doh) sanitizedEndpoints.doh = pickEndpointFields(endpoints.doh, ["enabled", "networks", "require_token"]);
  if (endpoints.dot) sanitizedEndpoints.dot = pickEndpointFields(endpoints.dot, ["enabled", "networks"]);
  if (endpoints.ipv4) sanitizedEndpoints.ipv4 = pickEndpointFields(endpoints.ipv4, ["enabled"]);
  if (endpoints.ipv6) sanitizedEndpoints.ipv6 = pickEndpointFields(endpoints.ipv6, ["enabled", "networks"]);
  if (Object.keys(sanitizedEndpoints).length > 0) payload.endpoints = sanitizedEndpoints;

  return payload;
}

/**
 * Serialize a Gateway location for IPv4 display in the dashboard.
 */
export function serializeGatewayLocationIpv4(location) {
  const protectedNetwork = getPrimaryIpv4Network(location);
  const ipv4Pair = [location.ipv4_destination, location.ipv4_destination_backup]
    .filter(Boolean)
    .join(" / ");
  const gatewayHostname = location.doh_subdomain
    ? `${location.doh_subdomain}.cloudflare-gateway.com`
    : "";

  return {
    locationName: location.name || "Cloudflare location",
    protectedNetwork,
    network: protectedNetwork,
    dnsEndpoints: {
      ipv4: getDnsEndpointValue(location.endpoints?.ipv4?.enabled, ipv4Pair),
      ipv6: getDnsEndpointValue(location.endpoints?.ipv6?.enabled, location.ip),
      dot: getDnsEndpointValue(location.endpoints?.dot?.enabled, gatewayHostname),
      doh: getDnsEndpointValue(location.endpoints?.doh?.enabled, gatewayHostname ? `https://${gatewayHostname}/dns-query` : ""),
    },
    updatedAt: location.updated_at || null,
  };
}
