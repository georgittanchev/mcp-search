import { FetchStrategy } from "../constants.js";
export interface FetchResult {
    ok: boolean;
    status: number;
    url: string;
    content: string;
    contentType: string;
    strategy: string;
    error?: string;
}
export declare function fetchUrl(url: string, strategy?: FetchStrategy): Promise<FetchResult>;
