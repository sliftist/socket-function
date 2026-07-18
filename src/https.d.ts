/// <reference types="node" />
/// <reference types="node" />
export interface HttpsResponseInfo {
    statusCode?: number;
    statusMessage?: string;
    headers: {
        [key: string]: string | undefined;
    };
}
export declare function httpsRequest(url: string, payload?: Buffer | Buffer[], method?: string, sendSessionCookies?: boolean, config?: {
    headers?: {
        [key: string]: string | undefined;
    };
    cancel?: Promise<void>;
    outResponse?: HttpsResponseInfo;
}): Promise<Buffer>;
