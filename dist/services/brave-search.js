import { BRAVE_API_BASE, DEFAULT_TIMEOUT_MS } from "../constants.js";
// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
function getApiKey() {
    const key = process.env.BRAVE_API_KEY;
    if (!key) {
        throw new Error("BRAVE_API_KEY environment variable is required. Get one at https://api-dashboard.search.brave.com/");
    }
    return key;
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function braveSearch(query, count = 10, offset = 0, country, searchLang, freshness) {
    const apiKey = getApiKey();
    const params = new URLSearchParams({
        q: query,
        count: String(Math.min(count, 20)), // Brave max is 20
    });
    if (offset > 0)
        params.set("offset", String(offset));
    if (country)
        params.set("country", country);
    if (searchLang)
        params.set("search_lang", searchLang);
    if (freshness)
        params.set("freshness", freshness); // pd, pw, pm, py, YYYY-MM-DDtoYYYY-MM-DD
    const url = `${BRAVE_API_BASE}?${params.toString()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
        const resp = await fetch(url, {
            method: "GET",
            headers: {
                Accept: "application/json",
                "Accept-Encoding": "gzip",
                "X-Subscription-Token": apiKey,
            },
            signal: controller.signal,
        });
        if (!resp.ok) {
            const body = await resp.text();
            return {
                query,
                results: [],
                total_estimated: 0,
                error: `Brave API returned ${resp.status}: ${body.slice(0, 500)}`,
            };
        }
        const data = (await resp.json());
        const webResults = data.web?.results ?? [];
        return {
            query: data.query?.original ?? query,
            results: webResults.map((r) => ({
                title: r.title ?? "",
                url: r.url ?? "",
                description: r.description ?? "",
                ...(r.age ? { age: r.age } : {}),
                ...(r.language ? { language: r.language } : {}),
                ...(r.extra_snippets?.length ? { extra_snippets: r.extra_snippets } : {}),
            })),
            total_estimated: webResults.length,
        };
    }
    catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
            return {
                query,
                results: [],
                total_estimated: 0,
                error: `Brave API request timed out after ${DEFAULT_TIMEOUT_MS}ms`,
            };
        }
        return {
            query,
            results: [],
            total_estimated: 0,
            error: `Brave API request failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=brave-search.js.map