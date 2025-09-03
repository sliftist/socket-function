import * as https from "https";
import * as http from "http";
import { isNode } from "./misc";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

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
            return new Promise<Buffer>((resolve, reject) => {
                let httpRequest = requestor.request(
                    urlObj + "",
                    {
                        method,
                        headers: config?.headers,
                        // NOTE: We get a lot of backblaze errors when we try to re-use connections. It might be faster,
                        //  but... anything that cares about speed should use websockets anyways...
                        agent: new requestor.Agent({ keepAlive: false }),
                    },
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
                if (request.status !== 200) {
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