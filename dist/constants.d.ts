export declare const USER_AGENTS: string[];
export declare const DEFAULT_TIMEOUT_MS = 30000;
export declare const JINA_TIMEOUT_MS = 45000;
export declare const CHARACTER_LIMIT = 100000;
export declare const BRAVE_API_BASE = "https://api.search.brave.com/res/v1/web/search";
export declare const JINA_READER_BASE = "https://r.jina.ai";
export declare enum FetchStrategy {
    DIRECT = "direct",
    JINA = "jina",
    AUTO = "auto"
}
export declare function getRandomUserAgent(): string;
export declare function getBrowserHeaders(ua: string): Record<string, string>;
