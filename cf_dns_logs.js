import { ACCOUNT_ID, API_TOKEN } from './lib/constants.js';
import dotenv from 'dotenv';
dotenv.config({ override: false });

/**
 * Retrieves top DNS domains and total query count from Cloudflare Zero Trust Gateway using GraphQL API
 * API docs: https://developers.cloudflare.com/cloudflare-one/insights/analytics/gateway/
 */
async function getTopDNSQueries(options = {}) {
  const {
    start = null,
    end = null,
  } = options;

  // Default to last 24 hours if no time range specified
  const now = new Date();
  const startTime = start || new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const endTime = end || now.toISOString();

  // GraphQL query for top DNS queries and total count
  const query = `
    query GetTopDNSQueries($accountTag: string!, $start: Time!, $end: Time!, $limit: Int!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          topN: gatewayResolverQueriesAdaptiveGroups(
            filter: {
              datetime_geq: $start,
              datetime_leq: $end
            }
            limit: $limit
          ) {
            count
            dimensions {
              queryNameReversed
            }
          }
          total: gatewayResolverQueriesAdaptiveGroups(
            filter: {
              datetime_geq: $start,
              datetime_leq: $end
            }
            limit: 10000
          ) {
            count
          }
        }
      }
    }
  `;

  const variables = {
    accountTag: ACCOUNT_ID,
    start: startTime,
    end: endTime,
    limit: 20, // Get top 20 domains - must be integer
  };

  try {
    console.log('Fetching total DNS query count from Cloudflare Zero Trust Gateway via GraphQL API...');
    console.log(`Time range: ${startTime} to ${endTime}`);
    
    const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(`GraphQL error: ${JSON.stringify(data.errors || data)}`);
    }

    const account = data.data?.viewer?.accounts[0];
    const topDomains = account?.topN || [];
    const totalResult = account?.total || [];
    
    // Sum all counts to get total
    const totalCount = totalResult.reduce((sum, item) => sum + (item.count || 0), 0);
    
    // Format top domains - reverse the domain name from queryNameReversed
    const formattedTopDomains = topDomains.map(item => ({
      domain: item.dimensions?.queryNameReversed ? item.dimensions.queryNameReversed.split('').reverse().join('') : 'N/A',
      count: item.count || 0,
    }));
    
    console.log(`Successfully retrieved ${formattedTopDomains.length} top domains, total queries: ${totalCount}`);
    return { topDomains: formattedTopDomains, totalCount };
  } catch (error) {
    console.error('Failed to fetch DNS query count:', error.message);
    throw error;
  }
}

/**
 * Retrieves top locations from Cloudflare Zero Trust Gateway using GraphQL API
 */
async function getTopLocations(options = {}) {
  const {
    start = null,
    end = null,
  } = options;

  // Default to last 24 hours if no time range specified
  const now = new Date();
  const startTime = start || new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const endTime = end || now.toISOString();

  // GraphQL query for top locations - try locationName dimension
  const query = `
    query GetTopLocations($accountTag: string!, $start: Time!, $end: Time!, $limit: Int!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          topN: gatewayResolverQueriesAdaptiveGroups(
            filter: {
              datetime_geq: $start,
              datetime_leq: $end
            }
            limit: $limit
          ) {
            count
            dimensions {
              locationName
            }
          }
          total: gatewayResolverQueriesAdaptiveGroups(
            filter: {
              datetime_geq: $start,
              datetime_leq: $end
            }
            limit: 10000
          ) {
            count
          }
        }
      }
    }
  `;

  const variables = {
    accountTag: ACCOUNT_ID,
    start: startTime,
    end: endTime,
    limit: 10, // Get top 10 locations
  };

  try {
    console.log('Fetching top locations from Cloudflare Zero Trust Gateway via GraphQL API...');
    console.log(`Time range: ${startTime} to ${endTime}`);

    const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(`GraphQL error: ${JSON.stringify(data.errors || data)}`);
    }

    const account = data.data?.viewer?.accounts?.[0];
    const topLocations = account?.topN || [];
    const totalResult = account?.total || [];

    // Sum all counts to get total
    const totalCount = totalResult.reduce((sum, item) => sum + (item.count || 0), 0);

    // Format top locations - locationName contains the location name
    const formattedTopLocations = topLocations.map(item => ({
      location: item.dimensions?.locationName || 'N/A',
      count: item.count || 0,
    }));

    console.log(`Successfully retrieved ${formattedTopLocations.length} top locations, total queries: ${totalCount}`);
    return { topLocations: formattedTopLocations, totalCount };
  } catch (error) {
    console.error('Failed to fetch top locations:', error.message);
    throw error;
  }
}

// Run the script
async function main() {
  try {
    // Get top DNS queries and total count for last 24 hours
    const { topDomains, totalCount } = await getTopDNSQueries();

    console.log(`\n=== Top DNS Domains (Last 24 Hours) ===`);
    console.log(`Total DNS queries: ${totalCount}\n`);

    console.log('Rank | Domain | Count');
    console.log('-----|--------|------');
    topDomains.forEach((item, index) => {
      console.log(`${(index + 1).toString().padStart(4)} | ${item.domain.padEnd(40)} | ${item.count}`);
    });

    // Get top locations
    const { topLocations, totalCount: locationTotal } = await getTopLocations();

    console.log(`\n=== Top Locations (Last 24 Hours) ===`);
    console.log(`Total DNS queries: ${locationTotal}\n`);

    console.log('Rank | Location | Count');
    console.log('-----|----------|------');
    topLocations.forEach((item, index) => {
      console.log(`${(index + 1).toString().padStart(4)} | ${item.location.padEnd(40)} | ${item.count}`);
    });
  } catch (error) {
    console.error('Error:', error.message);
    console.error('\nMake sure you have:');
    console.error('1. CLOUDFLARE_API_TOKEN set in your .env file');
    console.error('2. CLOUDFLARE_ACCOUNT_ID set in your .env file');
    console.error('3. The API token has "Account Analytics Read" permission');
    process.exit(1);
  }
}

main();
