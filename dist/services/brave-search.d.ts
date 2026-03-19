export interface BraveSearchResult {
    title: string;
    url: string;
    description: string;
    age?: string;
    language?: string;
    extra_snippets?: string[];
}
export interface BraveSearchResponse {
    query: string;
    results: BraveSearchResult[];
    total_estimated: number;
    error?: string;
}
export declare function braveSearch(query: string, count?: number, offset?: number, country?: string, searchLang?: string, freshness?: string): Promise<BraveSearchResponse>;
