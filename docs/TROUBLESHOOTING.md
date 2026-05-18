# CZGS Troubleshooting Guide

Common issues and their solutions for Cloudflare Zero Trust Gateway Scripts (CZGS).

## Table of Contents

1. [Cloudflare Credentials](#cloudflare-credentials)
2. [API Token Permissions](#api-token-permissions)
3. [Rate Limits (429 Errors)](#rate-limits-429-errors)
4. [Traffic Map Issues](#traffic-map-issues)
5. [Docker Data & Volumes](#docker-data--volumes)
6. [Dashboard Access Issues](#dashboard-access-issues)
7. [Rule Ordering](#rule-ordering)
8. [Sync Issues](#sync-issues)

---

## Cloudflare Credentials

### Problem: "Missing ACCOUNT_ID or API_TOKEN"

**Symptoms:**
- Error in logs: `Missing ACCOUNT_ID or API_TOKEN`
- Health check shows `"cloudflareConfigured": false`
- Cannot create lists or rules

**Diagnosis:**
Check your `.env` file:

```bash
# Should be present in .env
CLOUDFLARE_ACCOUNT_ID=your_account_id_here
CLOUDFLARE_API_TOKEN=your_api_token_here
```

**Solution:**

1. **Get Account ID:**
   - Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
   - Select your domain
   - Right sidebar shows **Account ID**
   - Or find in Zero Trust dashboard URL: `https://one.dash.cloudflare.com/<ACCOUNT_ID>/...`

2. **Create API Token:**
   - Go to [API Tokens](https://dash.cloudflare.com/profile/api-tokens)
   - Click **Create Token**
   - Use **Custom token** template
   - **Permissions needed:**
     - `Zero Trust:Edit` (for lists, rules, analytics)
   - **Account Resources:** Include your account
   - Click **Continue to summary** → **Create Token**

3. **Update .env:**
   ```bash
   CLOUDFLARE_ACCOUNT_ID=abc123def456
   CLOUDFLARE_API_TOKEN=your_token_here
   ```

4. **Restart the application:**
   ```bash
   # Native
   node server.js
   
   # Docker
   docker compose down
   docker compose up -d
   ```

**Verify:**
Check health endpoint:
```bash
curl http://localhost:3333/api/health
# Should show: "cloudflareConfigured": true
```

---

## API Token Permissions

### Problem: "Authentication error" or "Insufficient permissions"

**Symptoms:**
- Error: `Authentication error` when creating lists
- Error: `Insufficient permissions` when updating rules
- Some operations work, others fail

**Diagnosis:**
Check token permissions in Cloudflare dashboard:
1. Go to [API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Find your token
3. Check **Status** and **Permissions**

**Required Permissions:**

| Feature | Required Permission |
|---------|-------------------|
| List/Rule Management | `Zero Trust:Edit` |
| DNS Analytics | `Zero Trust:Edit` |
| Traffic Map | `Zero Trust:Edit` |
| Gateway Locations | `Zero Trust:Edit` |

**Solution:**

1. **Edit existing token:**
   - Click **Edit** on your token
   - Add `Zero Trust:Edit` permission
   - Save

2. **Or create new token:**
   - Follow steps in [Cloudflare Credentials](#cloudflare-credentials)

3. **Test with minimal scope:**
   ```bash
   curl -X GET "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/gateway/lists" \
     -H "Authorization: Bearer $API_TOKEN"
   ```

**Common Mistakes:**
- Using **Global API Key** instead of **API Token** (use token, not key)
- Using `Zero Trust:Read` only (need Edit for modifications)
- Token expired (regenerate)
- Wrong account selected in token

---

## Rate Limits (429 Errors)

### Problem: "Too many requests" or "Rate limit exceeded"

**Symptoms:**
- Error: `429 Too Many Requests`
- Sync fails intermittently
- Dashboard shows sync errors
- Logs show: `Rate limit exceeded, retrying...`

**Understanding Cloudflare Limits:**

| Endpoint | Limit |
|----------|-------|
| List operations | 1200 requests/5 minutes |
| Rule operations | 1200 requests/5 minutes |
| Gateway Analytics | 100 requests/1 minute |
| GraphQL Analytics | 100 requests/1 minute |

**Solution:**

1. **Automatic Retry (Built-in):**
   - The application has automatic retry with exponential backoff
   - Wait for retry to complete

2. **Reduce Sync Frequency:**
   ```bash
   # In .env - increase interval (default 15 min)
   # Currently not configurable via env, requires code change
   ```

3. **Manual Sync:**
   - Wait 5-10 minutes between sync attempts
   - Check Cloudflare dashboard for rate limit status

4. **Batch Operations:**
   - The app already batches list operations
   - Avoid running multiple instances simultaneously

5. **Check for Loops:**
   ```bash
   # Ensure you don't have multiple containers running
   docker ps | grep czgs
   
   # Should only show one instance
   ```

**When Rate Limited:**
- The sync will pause and retry automatically
- Traffic map data may be stale until retry succeeds
- DNS analytics will use cached data

---

## Traffic Map Issues

### Problem: Traffic map shows "No data available"

**Symptoms:**
- Map shows empty or "No data"
- No source/destination bubbles
- "No recent traffic data" message

**Causes & Solutions:**

**1. No DNS Traffic Through Gateway**
   - **Check:** Are devices configured to use Cloudflare Gateway DNS?
   - **Verify:** Check Gateway Analytics in Cloudflare dashboard
   - **Fix:** Configure devices to use Gateway DNS endpoints (shown in dashboard)

**2. Gateway Location Not Configured**
   - **Check:** `CLOUDFLARE_GATEWAY_LOCATION_ID` in `.env`
   - **Default:** Pre-configured, but verify it exists
   - **Fix:** Get location ID from Zero Trust → Gateway → Locations

**3. Data Not Synced Yet**
   - **First sync:** Takes 15 minutes after startup
   - **Check:** Wait for background sync to complete
   - **Force:** Click "Force Sync" in dashboard

**4. Insufficient API Permissions**
   - **Check:** Token has `Zero Trust:Edit` for analytics
   - **Error in logs:** `Traffic map GraphQL sync skipped: missing credentials`

**5. Geolocation Database Issues**
   - **Check:** Some IPs may not geolocate
   - **Verify:** Check logs for `unmappedCountries`
   - **Note:** Internal/private IPs won't show on map

**Verify Traffic Exists:**
```bash
# Check if Gateway is receiving queries
curl -X GET "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/gateway/analytics" \
  -H "Authorization: Bearer $API_TOKEN"
```

**Check Sync Status:**
```bash
# In server logs, look for:
"Traffic map GraphQL sync complete. Total queries: X, sources: Y..."
"DNS analytics sync complete. Buckets: X, Total queries in DB: Y"
```

---

## Docker Data & Volumes

### Problem: Data lost after container restart

**Symptoms:**
- Dashboard shows no historical data
- Settings reset to defaults
- Need to re-run initial setup

**Cause:**
Using `docker compose down` without the volume, or not using a named volume.

**Solution:**

1. **Check Volume Exists:**
   ```bash
   docker volume ls | grep czgs
   # Should show: czgs_czgs-data or similar
   ```

2. **Correct Way to Restart:**
   ```bash
   # Keep data
   docker compose restart
   
   # Or stop/start without -v flag
   docker compose down
   docker compose up -d
   ```

3. **Never Use:**
   ```bash
   # This DELETES all data!
   docker compose down -v
   docker volume rm czgs_czgs-data
   ```

4. **Backup Data (Recommended):**
   ```bash
   # Backup database
   docker cp czgs-app-1:/app/data/traffic_logs.db ./backup-$(date +%Y%m%d).db
   
   # Restore database
   docker cp ./backup-20240101.db czgs-app-1:/app/data/traffic_logs.db
   docker compose restart
   ```

5. **Verify Persistence:**
   ```bash
   # Check database file exists
   docker exec czgs-app-1 ls -la /app/data/
   
   # Should show: traffic_logs.db, manifest.json
   ```

**Docker Compose Configuration:**
```yaml
# docker-compose.yml (should have)
volumes:
  czgs-data:
    driver: local

services:
  app:
    volumes:
      - czgs-data:/app/data
```

---

### Problem: "Permission denied" on database

**Symptoms:**
- Error: `SQLITE_CANTOPEN: unable to open database file`
- Health check shows `"databaseWritable": false`
- Cannot save data

**Causes:**
- Volume permissions issue
- Container user cannot write to `/app/data`
- Volume mounted as read-only

**Solution:**

1. **Check Permissions:**
   ```bash
   docker exec czgs-app-1 ls -la /app/
   # /app/data should be writable
   ```

2. **Fix Permissions:**
   ```bash
   docker exec czgs-app-1 chmod 755 /app/data
   docker exec czgs-app-1 chown -R node:node /app/data
   ```

3. **Recreate Volume:**
   ```bash
   # Backup first!
   docker cp czgs-app-1:/app/data/traffic_logs.db ./backup.db
   
   # Remove and recreate
   docker compose down -v
   docker volume create czgs_czgs-data
   docker compose up -d
   
   # Restore
   docker cp ./backup.db czgs-app-1:/app/data/traffic_logs.db
   ```

---

## Dashboard Access Issues

### Problem: "Dashboard remote access is blocked"

**Symptoms:**
- Error: `Remote dashboard access is blocked by default`
- Cannot access dashboard from another machine
- Works on localhost, fails remotely

**Cause:**
No `DASHBOARD_PASSWORD` set, so only localhost access is allowed.

**Solution:**

1. **Set Password in .env:**
   ```bash
   DASHBOARD_PASSWORD=your_secure_password_here
   ```

2. **Restart:**
   ```bash
   docker compose restart
   # or
   node server.js
   ```

3. **Access with Password:**
   - Browser will prompt for Basic Auth
   - Username: `admin` (or `DASHBOARD_USERNAME` if set)
   - Password: The password you set

**Security Best Practices:**
- Use a strong password (20+ characters)
- Don't use default `admin` username in production
- Set `DASHBOARD_ALLOWED_ORIGINS` for additional CORS protection
- Disable auth only for local development: `DASHBOARD_AUTH_DISABLED=1` (not recommended for production)

---

### Problem: "Authentication required" loop

**Symptoms:**
- Browser keeps asking for password
- Cannot log in even with correct credentials
- 401 Unauthorized repeatedly

**Causes:**
- Wrong username/password
- Password contains special characters causing issues
- Browser caching old credentials

**Solution:**

1. **Clear Browser Cache:**
   - Clear site data/cookies for the domain
   - Or try Incognito/Private mode

2. **Check Credentials:**
   ```bash
   # Verify .env values
   cat .env | grep DASHBOARD
   ```

3. **Escape Special Characters:**
   - If password contains `$`, `!`, or spaces, quote it:
   ```bash
   DASHBOARD_PASSWORD="my$ecure!pass word"
   ```

4. **Check Logs:**
   ```bash
   docker logs czgs-app-1 | grep -i auth
   ```

---

## Rule Ordering

### Problem: Allowlist not working / domains still blocked

**Symptoms:**
- Added domain to custom allowlist
- Domain still resolves as blocked
- Allow rule exists but not effective

**Cause:**
Rule ordering in Cloudflare Gateway. Block rules are evaluated before allow rules by default.

**Understanding Rule Order:**

```
Cloudflare Gateway evaluates rules TOP-TO-BOTTOM:

1. [ALLOW RULE]  ← MUST BE FIRST
   Gateway Custom Allow Rule
   
2. [BLOCK RULE]
   CZGS Filter Lists
   
3. [OTHER RULES]
   ...
```

**Solution:**

1. **Check Rule Order in Cloudflare:**
   - Go to [Zero Trust Dashboard](https://one.dash.cloudflare.com)
   - Gateway → Firewall Policies → DNS
   - Verify **"Gateway Custom Allow Rule"** is at the TOP

2. **Move Rule Up:**
   - Drag the allow rule to position #1
   - Or use up arrow in list view

3. **Verify in CZGS:**
   - Dashboard shows warning: `RULE_ORDER_WARNING`
   - Menu shows warning after creating rule

4. **Test:**
   - Query an allowed domain:
   ```bash
   dig @your-gateway-dns allowed-domain.com
   # Should resolve, not be blocked
   ```

**Why This Happens:**
- Rules are evaluated sequentially
- First matching rule wins
- Block rule matches all CZGS list domains
- If allow rule is below block rule, it's never reached

---

### Problem: "Rule already exists" but not working

**Symptoms:**
- CZGS says rule created/updated
- But allowlist still not working
- Rule exists in Cloudflare but in wrong position

**Solution:**

1. **Check Rule Position:**
   - Cloudflare dashboard → Gateway → Firewall Policies
   - Look for `Gateway Custom Allow Rule`
   - Must be position #1

2. **Manual Fix:**
   - Drag rule to top
   - Or delete rule and let CZGS recreate it

3. **Recreate Rule:**
   ```bash
   # In CZGS menu or dashboard
   # Remove the rule in Cloudflare dashboard
   # Then re-run "Manage Custom Allowlist"
   ```

---

## Sync Issues

### Problem: "Sync complete" but no data changed

**Symptoms:**
- Sync reports success
- Lists/rules unchanged in Cloudflare
- Same domains still blocked/allowed

**Causes:**
- Manifest-based skip (data unchanged)
- Cloudflare eventual consistency
- Browser caching

**Solution:**

1. **Force Full Sync:**
   ```bash
   # In dashboard: Click "Force Sync"
   # In menu: Run full update
   
   # Or manually:
   node download_lists.js
   node cf_list_create.js --force  # if force flag implemented
   node cf_gateway_rule_create.js
   ```

2. **Check Manifest:**
   ```bash
   cat data/manifest.json
   # If hashes match, sync is skipped
   ```

3. **Clear Manifest:**
   ```bash
   rm data/manifest.json
   docker compose restart
   # This forces full re-sync on next start
   ```

4. **Verify in Cloudflare:**
   - Check Gateway Lists in Cloudflare dashboard
   - Verify domains are in the lists
   - Check list count matches expected

---

### Problem: Sync takes very long / hangs

**Symptoms:**
- Sync progress stops
- No updates for minutes
- Eventually times out

**Causes:**
- Large domain lists (100k+ domains)
- Rate limiting causing retries
- Cloudflare API slowness

**Solution:**

1. **Check List Size:**
   - Maximum: 300 lists × 1000 items = 300,000 domains
   - Large lists take longer to sync

2. **Monitor Progress:**
   - Watch server logs: `docker logs -f czgs-app-1`
   - Look for progress indicators

3. **Wait or Cancel:**
   - Large syncs can take 5-15 minutes
   - If stuck >30 minutes, restart:
   ```bash
   docker compose restart
   ```

4. **Optimize Sources:**
   - Reduce number of source URLs
   - Use more focused blocklists
   - Remove duplicates between sources

---

## General Debugging

### Enable Debug Logging

```bash
# In .env
DEBUG=czgs:*
LOG_LEVEL=debug
```

### Check All Logs

```bash
# Docker
docker logs czgs-app-1 --tail 100

# Native
node server.js 2>&1 | tee server.log
```

### Verify Health

```bash
curl http://localhost:3333/api/health | jq
```

Expected:
```json
{
  "ok": true,
  "cloudflareConfigured": true,
  "databaseWritable": true,
  "uptime": 12345,
  "version": "1.0.0"
}
```

### Reset Everything

**⚠️ WARNING: This deletes all data!**

```bash
# Stop and remove volumes
docker compose down -v

# Remove data directory (native)
rm -rf data/

# Restart fresh
docker compose up -d
```

### Get Help

If issues persist:

1. Check [GitHub Issues](https://github.com/yourusername/czgs/issues)
2. Include in bug report:
   - Error messages (sanitized)
   - Health check output
   - Relevant log snippets
   - Steps to reproduce

---

## Quick Reference

| Issue | Quick Fix |
|-------|-----------|
| Missing credentials | Check `.env` for `ACCOUNT_ID` and `API_TOKEN` |
| 429 errors | Wait 5 min, sync auto-retries |
| Empty traffic map | Check Gateway DNS configured on devices |
| Dashboard blocked | Set `DASHBOARD_PASSWORD` in `.env` |
| Data lost | Never use `docker compose down -v` |
| Allowlist not working | Move allow rule to #1 in Cloudflare |
| Sync stuck | Restart container, check logs |
| Database error | Check volume permissions |

---

## Related Documentation

- [README.md](./README.md) - Setup and configuration
- [ARCHITECTURE.md](./ARCHITECTURE.md) - System design
- Cloudflare Docs: [Gateway Get Started](https://developers.cloudflare.com/cloudflare-one/policies/gateway/)
