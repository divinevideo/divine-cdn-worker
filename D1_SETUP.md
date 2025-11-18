# D1 Database Setup Instructions

## Step 1: Create the D1 Database

You need to create the database through the Cloudflare Dashboard or with an API token that has D1 permissions.

### Option A: Via Cloudflare Dashboard
1. Go to https://dash.cloudflare.com
2. Select your account
3. Go to **Workers & Pages** → **D1**
4. Click **Create database**
5. Name it: `blossom-webhook-events`
6. Click **Create**
7. Copy the **Database ID** (looks like: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)

### Option B: Via CLI (if you have permissions)
```bash
wrangler d1 create blossom-webhook-events
```

This will output the database ID. Copy it.

## Step 2: Update wrangler.toml

Replace the placeholder in `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "blossom-webhook-events"
database_id = "YOUR_DATABASE_ID_HERE"  # Replace this!
```

Also add to production environment:

```toml
[[env.production.d1_databases]]
binding = "DB"
database_name = "blossom-webhook-events"
database_id = "YOUR_DATABASE_ID_HERE"  # Same ID
```

## Step 3: Initialize the Schema

### Option A: Via Cloudflare Dashboard (Recommended)
1. Go to https://dash.cloudflare.com
2. Workers & Pages → D1 → `blossom-webhook-events`
3. Click **Console** tab
4. Copy and paste the contents of `schema-d1-tables.sql` and click **Execute**
5. Then copy and paste the contents of `schema-d1-indexes.sql` and click **Execute**

### Option B: Via CLI (if you have full permissions)
```bash
wrangler d1 execute blossom-webhook-events --file=./schema-d1-tables.sql --remote
wrangler d1 execute blossom-webhook-events --file=./schema-d1-indexes.sql --remote
```

## Step 4: Verify Tables Created

```bash
wrangler d1 execute blossom-webhook-events --command="SELECT name FROM sqlite_master WHERE type='table'"
```

Should show:
- `bunny_webhook_events`
- `video_metadata`

## Step 5: Deploy Updated Worker

```bash
npm run deploy
```

## Testing D1 Logging

After deployment, webhook events will automatically be logged to D1.

Query recent events:
```bash
wrangler d1 execute blossom-webhook-events --command="SELECT video_guid, status_name, timestamp FROM bunny_webhook_events ORDER BY received_at DESC LIMIT 10"
```

Query by SHA-256:
```bash
wrangler d1 execute blossom-webhook-events --command="SELECT * FROM bunny_webhook_events WHERE sha256 = 'your_sha256_here'"
```

## Troubleshooting

If you get "Authentication error" when running wrangler d1 commands:
- Your API token needs D1 permissions
- Or use `wrangler login` to authenticate with OAuth instead of API token
- Or create the database through the Cloudflare Dashboard
