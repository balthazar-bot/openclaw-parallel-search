import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";

type AnyObj = Record<string, any>;

type SearchResult = {
  position: number;
  title: string;
  url: string;
  description?: string;
  domain?: string;
  type: string;
  found_by: string[];
};

type ParallelSearchOutput = {
  query: string;
  results: SearchResult[];
  stats: {
    dataforseo_count: number;
    brave_count: number;
    total_unique: number;
    common: number;
    dataforseo_cost?: number;
  };
  errors?: {
    dataforseo?: string;
    brave?: string;
  };
};

// Map common country names to Brave ISO-2 codes
const COUNTRY_TO_ISO: Record<string, string> = {
  france: "FR", germany: "DE", spain: "ES", italy: "IT", portugal: "PT",
  netherlands: "NL", belgium: "BE", switzerland: "CH", austria: "AT",
  "united states": "US", "united kingdom": "GB", canada: "CA", australia: "AU",
  brazil: "BR", mexico: "MX", argentina: "AR", chile: "CL", japan: "JP",
  china: "CN", india: "IN", "south korea": "KR", indonesia: "ID",
  malaysia: "MY", philippines: "PH", "hong kong": "HK", taiwan: "TW",
  "new zealand": "NZ", "south africa": "ZA", "saudi arabia": "SA",
  turkey: "TR", russia: "RU", poland: "PL", sweden: "SE", norway: "NO",
  denmark: "DK", finland: "FI", greece: "GR", singapore: "SG",
};

function countryToIso(country: string): string {
  if (!country) return "";
  const upper = country.toUpperCase().trim();
  // Already a 2-letter code?
  if (upper.length === 2) return upper;
  // Lookup by name
  return COUNTRY_TO_ISO[country.toLowerCase().trim()] || upper;
}

function safeTrim(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function domainFromUrl(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

const TRACKING_PARAMS = new Set([
  "srsltid",
  "gclid",
  "fbclid",
  "msclkid",
  "yclid",
  "gbraid",
  "wbraid",
]);

function isTrackingParam(key: string): boolean {
  const k = key.toLowerCase();
  if (TRACKING_PARAMS.has(k)) return true;
  if (k.startsWith("utm_")) return true;
  return false;
}

function normalizeUrl(input: string): string {
  try {
    const url = new URL(input);
    url.hash = "";
    url.username = "";
    url.password = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");

    // Strip tracking params (keep other params, sorted for stability)
    const kept: [string, string][] = [];
    for (const [k, v] of url.searchParams.entries()) {
      if (!isTrackingParam(k)) kept.push([k, v]);
    }
    kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
    url.search = "";
    for (const [k, v] of kept) url.searchParams.append(k, v);

    // Trailing slash normalization
    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/, "");
      if (!url.pathname.startsWith("/")) url.pathname = `/${url.pathname}`;
    }

    // Normalize default ports
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
      url.port = "";
    }

    return url.toString();
  } catch {
    // Fallback (best effort)
    return String(input || "").trim();
  }
}

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<any> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON response: ${text.slice(0, 500)}`);
    }
  } finally {
    clearTimeout(t);
  }
}

async function resolveDataForSeoCreds(api: AnyObj): Promise<{ login: string; password: string } | null> {
  const cfg = (api?.pluginConfig ?? {}) as AnyObj;
  const login = safeTrim(cfg.dataforseoLogin) || safeTrim(process.env.DATAFORSEO_LOGIN);
  const password = safeTrim(cfg.dataforseoPassword) || safeTrim(process.env.DATAFORSEO_PASSWORD);
  if (login && password) return { login, password };

  // Try secrets file
  try {
    const raw = await fs.readFile(
      "/home/ubuntu/.openclaw/workspace/secrets/dataforseo_credentials.json",
      "utf8",
    );
    const json = JSON.parse(raw);
    const fileLogin = safeTrim(json?.login);
    const filePassword = safeTrim(json?.password);
    if (fileLogin && filePassword) return { login: fileLogin, password: filePassword };
  } catch {
    // ignore
  }
  return null;
}

function resolveBraveApiKey(api: AnyObj): string {
  const cfg = (api?.pluginConfig ?? {}) as AnyObj;
  const direct = safeTrim(cfg.braveApiKey);
  if (direct) return direct;

  const fromCore = safeTrim(api?.config?.tools?.web?.search?.apiKey);
  if (fromCore) return fromCore;

  return safeTrim(process.env.BRAVE_API_KEY);
}

async function searchDataForSeo(
  api: AnyObj,
  query: string,
  lang: string,
  country: string,
  depth: number,
): Promise<{ results: Omit<SearchResult, "position" | "found_by">[]; cost?: number } | null> {
  const creds = await resolveDataForSeoCreds(api);
  if (!creds) return null;

  const auth = Buffer.from(`${creds.login}:${creds.password}`).toString("base64");
  const body = [
    {
      keyword: query,
      language_code: lang,
      location_name: country,
      depth,
    },
  ];

  const json = await fetchJsonWithTimeout(
    "https://api.dataforseo.com/v3/serp/google/organic/live/advanced",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    15_000,
  );

  const task = json?.tasks?.[0];
  const cost = typeof task?.cost === "number" ? task.cost : undefined;

  const items: any[] =
    (task?.result?.[0]?.items) ||
    (task?.result?.items) ||
    (task?.items) ||
    [];

  const mapped = (Array.isArray(items) ? items : [])
    .filter((it) => it && typeof it === "object")
    .map((it) => {
      const url = safeTrim(it.url || it.link || it?.ranked_url || it?.href);
      const title = safeTrim(it.title);
      const description = safeTrim(it.description || it.snippet || it?.text);
      const type = safeTrim(it.type) || "organic";
      return {
        title: title || url,
        url,
        description: description || undefined,
        domain: url ? domainFromUrl(url) : undefined,
        type: type || "organic",
      };
    })
    .filter((r) => r.url);

  return { results: mapped, cost };
}

async function searchBrave(
  api: AnyObj,
  query: string,
  lang: string,
  country: string,
  count: number,
  freshness?: string,
): Promise<{ results: Omit<SearchResult, "position" | "found_by">[] } | null> {
  const apiKey = resolveBraveApiKey(api);
  if (!apiKey) return null;

  const u = new URL("https://api.search.brave.com/res/v1/web/search");
  u.searchParams.set("q", query);
  u.searchParams.set("count", String(count));
  if (lang) u.searchParams.set("search_lang", lang);
  const braveCountry = countryToIso(country);
  if (braveCountry) u.searchParams.set("country", braveCountry);
  if (freshness) u.searchParams.set("freshness", freshness);

  const json = await fetchJsonWithTimeout(
    u.toString(),
    {
      method: "GET",
      headers: {
        "X-Subscription-Token": apiKey,
        Accept: "application/json",
      },
    },
    15_000,
  );

  const items: any[] = (json?.web?.results) || (json?.results) || [];
  const mapped = (Array.isArray(items) ? items : [])
    .filter((it) => it && typeof it === "object")
    .map((it) => {
      const url = safeTrim(it.url);
      const title = safeTrim(it.title);
      const description = safeTrim(it.description);
      const type = "organic";
      return {
        title: title || url,
        url,
        description: description || undefined,
        domain: url ? domainFromUrl(url) : undefined,
        type,
      };
    })
    .filter((r) => r.url);

  return { results: mapped };
}

function mergeAndDedupe(
  dataforseo: { results: Omit<SearchResult, "position" | "found_by">[] } | null,
  brave: { results: Omit<SearchResult, "position" | "found_by">[] } | null,
): { merged: SearchResult[]; common: number } {
  const byNorm = new Map<
    string,
    {
      base: Omit<SearchResult, "position">;
      norm: string;
      sources: Set<string>;
    }
  >();

  const add = (engine: "dataforseo" | "brave", r: Omit<SearchResult, "position" | "found_by">) => {
    const norm = normalizeUrl(r.url);
    const existing = byNorm.get(norm);
    if (existing) {
      existing.sources.add(engine);
      // Keep DataForSEO's title/desc as priority; only fill gaps
      if (engine === "dataforseo") {
        existing.base = { ...r, found_by: [] } as any;
      } else {
        if (!existing.base.title && r.title) existing.base.title = r.title;
        if (!existing.base.description && r.description) existing.base.description = r.description;
        if (!existing.base.domain && r.domain) existing.base.domain = r.domain;
      }
      return;
    }

    byNorm.set(norm, {
      norm,
      sources: new Set([engine]),
      base: { ...r, found_by: [] } as any,
    });
  };

  for (const r of dataforseo?.results ?? []) add("dataforseo", r);
  for (const r of brave?.results ?? []) add("brave", r);

  let common = 0;
  const merged: SearchResult[] = [];
  for (const entry of byNorm.values()) {
    if (entry.sources.size > 1) common++;
  }

  // Order: DataForSEO first (SERP Google priority), then Brave-only leftovers.
  const dataKeys = new Set((dataforseo?.results ?? []).map((r) => normalizeUrl(r.url)));

  const orderedNorms: string[] = [];
  for (const r of dataforseo?.results ?? []) {
    const norm = normalizeUrl(r.url);
    if (byNorm.has(norm) && !orderedNorms.includes(norm)) orderedNorms.push(norm);
  }
  for (const r of brave?.results ?? []) {
    const norm = normalizeUrl(r.url);
    if (!dataKeys.has(norm) && byNorm.has(norm) && !orderedNorms.includes(norm)) orderedNorms.push(norm);
  }

  // Fallback in case of weirdness
  if (orderedNorms.length === 0) {
    orderedNorms.push(...byNorm.keys());
  }

  orderedNorms.forEach((norm, idx) => {
    const entry = byNorm.get(norm);
    if (!entry) return;
    const sources = Array.from(entry.sources);
    // stable order in found_by
    sources.sort((a, b) => (a === "dataforseo" ? -1 : b === "dataforseo" ? 1 : a.localeCompare(b)));
    merged.push({
      position: idx + 1,
      title: entry.base.title,
      url: entry.base.url,
      description: entry.base.description,
      domain: entry.base.domain,
      type: entry.base.type || "organic",
      found_by: sources,
    });
  });

  return { merged, common };
}

export default function parallelSearchPlugin(api: AnyObj) {
  api.logger?.info?.("parallel-search: registering tool parallel_search");

  api.registerTool({
    name: "parallel_search",
    label: "Parallel Search",
    description:
      "Search the web using DataForSEO + Brave in parallel, merge and deduplicate results.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      count: Type.Optional(
        Type.Number({
          description: "Number of results per engine (default 10)",
          minimum: 1,
          maximum: 50,
        }),
      ),
      country: Type.Optional(Type.String({ description: "Country for results (default: France)" })),
      language: Type.Optional(Type.String({ description: "Language code (default: fr)" })),
      freshness: Type.Optional(
        Type.String({ description: "Freshness filter for Brave (pd, pw, pm, py)" }),
      ),
    }),

    async execute(_toolCallId: string, params: AnyObj) {
      const query = safeTrim(params?.query);
      if (!query) {
        return {
          content: [{ type: "text", text: "Missing required param: query" }],
          details: { error: "query required" },
        };
      }

      const pluginCfg = (api?.pluginConfig ?? {}) as AnyObj;
      const depth = Math.max(
        1,
        Math.min(
          50,
          Number.isFinite(Number(params?.count))
            ? Number(params.count)
            : Number.isFinite(Number(pluginCfg.defaultDepth))
              ? Number(pluginCfg.defaultDepth)
              : 10,
        ),
      );
      const lang = safeTrim(params?.language) || safeTrim(pluginCfg.defaultLanguage) || "fr";
      const country = safeTrim(params?.country) || safeTrim(pluginCfg.defaultCountry) || "France";
      const freshness = safeTrim(params?.freshness) || undefined;

      const errors: ParallelSearchOutput["errors"] = {};

      const [dataRes, braveRes] = await Promise.allSettled([
        searchDataForSeo(api, query, lang, country, depth),
        searchBrave(api, query, lang, country, depth, freshness),
      ]);

      let data: { results: Omit<SearchResult, "position" | "found_by">[]; cost?: number } | null =
        null;
      let brave: { results: Omit<SearchResult, "position" | "found_by">[] } | null = null;

      if (dataRes.status === "fulfilled") {
        data = dataRes.value;
      } else {
        errors.dataforseo = String(dataRes.reason?.message || dataRes.reason || "DataForSEO failed");
        api.logger?.warn?.(`parallel-search: DataForSEO failed: ${errors.dataforseo}`);
      }

      if (braveRes.status === "fulfilled") {
        brave = braveRes.value;
      } else {
        errors.brave = String(braveRes.reason?.message || braveRes.reason || "Brave failed");
        api.logger?.warn?.(`parallel-search: Brave failed: ${errors.brave}`);
      }

      const mergedInfo = mergeAndDedupe(data, brave);

      const output: ParallelSearchOutput = {
        query,
        results: mergedInfo.merged,
        stats: {
          dataforseo_count: data?.results?.length ?? 0,
          brave_count: brave?.results?.length ?? 0,
          total_unique: mergedInfo.merged.length,
          common: mergedInfo.common,
          dataforseo_cost: typeof data?.cost === "number" ? data.cost : undefined,
        },
      };

      if (errors.dataforseo || errors.brave) {
        // Only attach errors if something actually failed; skipped engines stay silent.
        if (!(data === null && !errors.dataforseo)) {
          // no-op
        }
        output.errors = Object.keys(errors).length ? errors : undefined;
      }

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        details: output,
      };
    },
  });
}
