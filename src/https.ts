import * as https from "https";
import * as http from "http";
import { isNode } from "./misc";
import { delay } from "./batching";
import { dnsCacheLookup, reportConnectionFailure } from "./dnsCache";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Error codes that mean the TCP connection was never established (so no request bytes reached the server
//  and a full retry — even of a non-idempotent method — is safe). These are the failures a stale DNS
//  answer produces, and the only ones we re-resolve + retry on.
const CONNECTION_ERROR_CODES = new Set([
    "EAI_AGAIN",
    "ENOTFOUND",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EHOSTDOWN",
    "EADDRNOTAVAIL",
]);
// Upper bound on retries; the real limiter is the DNS re-resolve throttle, which stops us once a fresh
//  answer can't differ from what we already tried.
const CONNECTION_RETRY_COUNT = 3;
// A short pause before retrying, giving a transient network/resolver blip time to clear.
const CONNECTION_RETRY_WAIT = 500;

function isConnectionError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    let code = (error as NodeJS.ErrnoException).code;
    if (code && CONNECTION_ERROR_CODES.has(code)) return true;
    // autoSelectFamily surfaces all-candidates-failed as an AggregateError; treat it as connection-level
    //  if any underlying attempt was.
    let aggregate = (error as AggregateError).errors;
    if (Array.isArray(aggregate) && aggregate.some(isConnectionError)) return true;
    let cause = (error as { cause?: unknown }).cause;
    if (cause && cause !== error) return isConnectionError(cause);
    return false;
}

export function httpsRequest(
    url: string,
    payload?: Buffer | Buffer[],
    method = "GET",
    sendSessionCookies = true,
    config?: {
        headers?: { [key: string]: string | undefined },
        cancel?: Promise<void>;
    }
): Promise<Buffer> {
    if (isNode()) {
        return (async () => {
            let urlObj = new URL(url);

            let requestor = url.startsWith("https") ? https : http;
            let port = url.startsWith("https") ? 443 : 80;
            if (urlObj.port) {
                port = +urlObj.port;
            }

            let attempt = 0;
            while (true) {
                try {
                    return await sendOnce();
                } catch (e) {
                    if (attempt >= CONNECTION_RETRY_COUNT || !isConnectionError(e)) {
                        throw e;
                    }
                    attempt++;
                    // A brief pause lets a transient blip settle, then we ask the DNS cache to re-resolve.
                    //  If it declines (throttled — a fresh answer would match what just failed), retrying
                    //  is pointless, so we surface the original error instead of looping.
                    await delay(CONNECTION_RETRY_WAIT);
                    let willReresolve = await reportConnectionFailure(urlObj.hostname);
                    if (!willReresolve) {
                        throw e;
                    }
                }
            }

            function sendOnce() {
                return new Promise<Buffer>((resolve, reject) => {
                    let httpRequest = requestor.request(
                        urlObj + "",
                        {
                            method,
                            headers: config?.headers,
                            // NOTE: We get a lot of backblaze errors when we try to re-use connections. It might be faster,
                            //  but... anything that cares about speed should use websockets anyways...
                            agent: new requestor.Agent({ keepAlive: false }),
                            // Resolve via our own DNS cache so we can bypass glibc's sticky failure caching and
                            //  re-resolve on demand. autoSelectFamily forces happy eyeballs across the returned
                            //  addresses even on older Node.
                            lookup: dnsCacheLookup,
                            autoSelectFamily: true,
                        } as https.RequestOptions,
                        async httpResponse => {
                            let data: Buffer[] = [];
                            httpResponse.on("data", chunk => {
                                data.push(chunk);
                            });

                            await new Promise<void>(resolve => {
                                httpResponse.on("end", () => {
                                    resolve();
                                });
                            });

                            if (!httpResponse.statusCode?.toString().startsWith("2")) {
                                reject(new Error(`Error for ${url}, ${httpResponse.statusCode} ${httpResponse.statusMessage}\n` + Buffer.concat(data).toString()));
                            } else {
                                resolve(Buffer.concat(data));
                            }
                        }
                    );
                    if (config?.cancel) {
                        void config.cancel.finally(() => {
                            httpRequest.destroy();
                        });
                    }
                    httpRequest.on("error", reject);

                    if (payload) {
                        if (Array.isArray(payload)) {
                            payload = Buffer.concat(payload);
                        }
                        httpRequest.write(payload);
                    }
                    httpRequest.end();
                });
            }
        })();

    } else {
        var request = new XMLHttpRequest();
        request.open(method, url, true);
        if (config?.headers) {
            for (let [key, value] of Object.entries(config.headers)) {
                if (value === undefined) continue;
                request.setRequestHeader(key, value);
            }
        }
        if (config?.cancel) {
            void config.cancel.finally(() => {
                request.abort();
            });
        }
        request.responseType = "arraybuffer";
        request.withCredentials = sendSessionCookies;
        if (payload) {
            if (Array.isArray(payload)) {
                payload = Buffer.concat(payload);
            }
            request.send(payload);
        } else {
            request.send();
        }
        return new Promise((resolve, reject) => {
            request.onload = () => {
                if (!request.status.toString().startsWith("2")) {
                    try {
                        // It should be an error.stack. But if it isn't... just throw the status text...
                        let responseText = textDecoder.decode(request.response);
                        let message = responseText.split("\n")[0];

                        let error = new Error(`For ${url}, ` + message);
                        error.stack = `For ${url}, ` + responseText;

                        reject(error);

                    } catch (e: any) {
                        reject(new Error(`For ${url}, ` + request.statusText));
                    }
                } else {
                    resolve(Buffer.from(request.response));
                }
            };

            request.onerror = (e) => {
                reject(new Error(`Network error for request at ${url}`));
            };
            request.ontimeout = (e) => {
                reject(new Error(`Network timeout for request at ${url}`));
            };
            request.onabort = (e) => {
                reject(new Error(`Network abort for request at ${url}`));
            };
        });
    }
}