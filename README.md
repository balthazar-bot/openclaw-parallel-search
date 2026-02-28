# parallel-search — OpenClaw Plugin

Dual-engine web search plugin for OpenClaw. Runs **DataForSEO** (Google SERP) and **Brave Search** in parallel, then merges and deduplicates results.

## Why?

No single search API catches everything. DataForSEO gives you Google's actual SERP (including local packs, knowledge panels). Brave has its own independent index. Running both in parallel and fusing results gives significantly better coverage — typically 30-50% more unique results than either engine alone.

## Features

- **Parallel execution** — both engines fire simultaneously via `Promise.allSettled`
- **Graceful degradation** — if one engine fails or has no credentials, the other still returns results
- **Smart deduplication** — URL normalization strips `www.`, trailing slashes, tracking params (`utm_*`, `srsltid`, `gclid`, `fbclid`, etc.)
- **Source attribution** — each result includes `found_by: ["dataforseo", "brave"]` showing which engine(s) found it
- **Country mapping** — accepts both full names (`"France"`) and ISO codes (`"FR"`); auto-converts for each API
- **Cost tracking** — DataForSEO cost per query included in stats
- **15s timeout** per engine (configurable via AbortController)

## Installation

```bash
# Copy to OpenClaw extensions directory
cp -r parallel-search ~/.openclaw/extensions/

# Install dependency
cd ~/.openclaw/extensions/parallel-search
npm install

# Restart gateway
openclaw gateway restart
# or: systemctl --user restart openclaw-gateway
```

Verify:
```bash
openclaw plugins list
# Should show: parallel-search | loaded
```

## Configuration

### Credentials

The plugin resolves credentials in this order:

**DataForSEO:**
1. Plugin config: `plugins.entries.parallel-search.config.dataforseoLogin` / `.dataforseoPassword`
2. Environment variables: `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD`

**Brave Search:**
1. Plugin config: `plugins.entries.parallel-search.config.braveApiKey`
2. OpenClaw core config: `tools.web.search.apiKey` (if you already have Brave configured)
3. Environment variable: `BRAVE_API_KEY`

If credentials are missing for an engine, it's silently skipped (no error).

### Optional config (openclaw.json)

```json5
{
  plugins: {
    entries: {
      "parallel-search": {
        enabled: true,
        config: {
          dataforseoLogin: "your-login@email.com",
          dataforseoPassword: "your-api-password",
          braveApiKey: "BSA...",          // optional if already in tools.web.search
          defaultLanguage: "fr",          // default: "fr"
          defaultCountry: "France",       // default: "France"
          defaultDepth: 10               // default: 10
        }
      }
    }
  }
}
```

## Tool: `parallel_search`

Once loaded, the agent has access to a `parallel_search` tool.

### Parameters

| Parameter   | Type   | Required | Description |
|------------|--------|----------|-------------|
| `query`    | string | ✅       | Search query |
| `count`    | number | ❌       | Results per engine (1-50, default: 10) |
| `country`  | string | ❌       | Country name or ISO code (default: "France") |
| `language` | string | ❌       | Language code (default: "fr") |
| `freshness`| string | ❌       | Brave freshness filter: `pd` / `pw` / `pm` / `py` |

### Output

```json
{
  "query": "tropical wood suppliers",
  "results": [
    {
      "position": 1,
      "title": "Example Result",
      "url": "https://example.com/page",
      "description": "A relevant snippet...",
      "domain": "example.com",
      "type": "organic",
      "found_by": ["dataforseo", "brave"]
    }
  ],
  "stats": {
    "dataforseo_count": 10,
    "brave_count": 8,
    "total_unique": 15,
    "common": 3,
    "dataforseo_cost": 0.002
  }
}
```

### Result ordering

1. DataForSEO results first (preserving Google SERP ranking)
2. Brave-only results appended after
3. Duplicates merged with `found_by` showing both sources

## Costs

- **DataForSEO**: ~$0.002 per SERP query (PAYG, no subscription required)
- **Brave**: Free tier available (1 req/sec, 2000/month), paid plans from $5/month
- **Total**: A typical dual-engine search costs ~$0.002

## Getting API Keys

- **DataForSEO**: [dataforseo.com](https://dataforseo.com) — sign up, get login + password, minimum deposit $10
- **Brave Search**: [brave.com/search/api](https://brave.com/search/api/) — free tier or paid plans

## License

MIT
