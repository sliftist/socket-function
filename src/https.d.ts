/// <reference types="node" />
/// <reference types="node" />
export declare function httpsRequest(url: string, payload?: Buffer | Buffer[], method?: string, sendSessionCookies?: boolean, config?: {
    headers?: {
        [key: string]: string | undefined;
    };
    cancel?: Promise<void>;
}): Promise<Buffer>;
