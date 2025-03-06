import http from "http";
import tls from "tls";
import { CallerContext, CallType, FullCallType } from "../SocketFunctionTypes";
import { isDataImmutable, performLocalCall } from "./callManager";
import { SocketFunction } from "../SocketFunction";
import { gzip } from "zlib";
import zlib from "zlib";
import { formatNumberSuffixed, getRootDomain, sha256Hash } from "./misc";
import { getClientNodeId, getNodeId } from "./nodeCache";

let defaultHTTPCall: CallType | undefined;

export function setDefaultHTTPCall(call: CallType) {
    defaultHTTPCall = call;
}

export function getServerLocationFromRequest(request: http.IncomingMessage) {
    let host = request.headers.host;
    if (!host) {
        throw new Error(`Missing host in request headers`);
    }
    let port = 443;
    if (host.includes(":")) {
        port = +host.split(":")[1];
        host = host.split(":")[0];
    }
    return {
        address: host,
        // This is OUR location, so whatever they connected to us... we must be listening on!
        //  (and the localPort doesn't matter in this case)
        port,
    };
}

export function getNodeIdsFromRequest(request: http.IncomingMessage) {
    // TODO: Support passing signed proof of userCertificate via headers in the HTTP request.
    //  THAT WAY HTTP can have consistent nodeIds, instead of making them randomly every time!
    //  (This isn't needed or possible for websockets, but they stay open, so calling functions
    //      after they open to set the nodeId is possible, and preferred).
    let remoteAddress = request.socket.remoteAddress?.split(":").pop();
    if (!remoteAddress) {
        throw new Error(`Missing remoteAddress`);
    }
    const nodeId = getClientNodeId(remoteAddress);

    const serverLocation = getServerLocationFromRequest(request);
    // IMPORTANT! Not the actual local id, but is the id the client called
    const localNodeId = getNodeId(serverLocation.address, serverLocation.port);
    return { nodeId, localNodeId };
}

let requests = new Map<CallerContext, http.IncomingMessage>();
export function getCurrentHTTPRequest(): http.IncomingMessage | undefined {
    return requests.get(SocketFunction.getCaller());
}

export async function httpCallHandler(request: http.IncomingMessage, response: http.ServerResponse) {
    try {
        // Always set x-frame-options, to prevent iframe embedding click hijacking
        response.setHeader("X-Frame-Options", "SAMEORIGIN");
        // Don't keep alive, to prevent issues with zombie sockets.
        response.setHeader("Connection", "close");

        // CORS bs (due to having to explictly allow subdomains)
        {
            response.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
            response.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
            // NOTE: "credentialless" would work here too
            response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");

            let origin = request.headers.origin || request.headers.referer;
            let allowed = false;
            if (!origin) {
                // I guess it's a script, so just allow it (as it could easily set any header it wanted anyways)
                allowed = true;
                origin = "*";
            } else {
                let host = request.headers.host;
                if (!host) {
                    throw new Error("Missing host in request headers");
                }
                let hostDomain = getRootDomain(host);
                let originDomain = getRootDomain(origin);
                allowed = hostDomain === originDomain;
                if (!allowed) {
                    console.log(`Rejected CORS, hostDomain: ${hostDomain} !== ${originDomain}`);
                }
            }

            // Allow if it has no origin, as that means it isn't a CORS request?
            if (allowed) {
                response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
            } else {
                response.setHeader("Cross-Origin-Resource-Policy", "same-site");
            }

            response.setHeader("vary", "Access-Control-Request-Headers");
            response.setHeader("Access-Control-Allow-Origin", allowed ? origin : "");

            if (allowed) {
                response.setHeader("Access-Control-Allow-Credentials", "true");
                response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
                response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Content-Length, X-Requested-With, x-uncompressed-content-length, Cookie");
            }
            response.setHeader("Access-Control-Expose-Headers", "x-uncompressed-content-length");
        }


        let urlBase = request.url;
        if (!urlBase) {
            throw new Error("Missing URL");
        }
        if (urlBase === "/favicon.ico") {
            response.end();
            return;
        }

        let protocol = "https";
        let url = protocol + "://" + request.headers.host + request.url;

        if (SocketFunction.logMessages) {
            console.log(`HTTP request (${request.method}) ${url}`);
        }
        let urlObj = new URL(url);

        let payload = await new Promise<Buffer>((resolve, reject) => {
            let data: Buffer[] = [];
            request
                .on("data", chunk => data.push(chunk))
                .on("end", () => resolve(Buffer.concat(data)))
                .on("error", (err) => reject(err))
                ;
        });

        const { nodeId, localNodeId } = getNodeIdsFromRequest(request);

        let caller: CallerContext = {
            nodeId,
            localNodeId,
        };

        let classGuid = urlObj.searchParams.get("classGuid");
        let functionName = urlObj.searchParams.get("functionName");
        let args: string | unknown[] | null = urlObj.searchParams.get("args");

        if (!classGuid) {
            if (defaultHTTPCall) {
                classGuid = defaultHTTPCall.classGuid;
                functionName = defaultHTTPCall.functionName;
                args = defaultHTTPCall.args;
            } else {
                throw new Error("Missing classGuid in URL query");
            }
        }
        if (!functionName) {
            throw new Error("Missing functionName in URL query");
        }

        if (!args) {
            args = [];
        } else {
            if (typeof args === "string") {
                args = JSON.parse(args) as unknown[];
            }
        }

        if (payload.length > 0) {
            args = JSON.parse(payload.toString())["args"] as unknown[];
        }

        let call: FullCallType = {
            nodeId,
            classGuid,
            functionName,
            args,
        };

        if (isDataImmutable(call)) {
            /** ETag cache, BUT, hashes only the input. Only valid for fully immutable resources
             *      (ex data storage, as any endpoints that run code could have that code change).
             *      - Shouldn't be needed, but I am seeing chrome fail to cache a lot of requests,
             *          which could cost us multiple dollars in server costs from atlas.
            */
            response.setHeader("cache-control", "public, max-age=15206400, immutable");
            let hash = sha256Hash(Buffer.from(JSON.stringify(call)));
            response.setHeader("ETag", hash);
            if (request.headers["if-none-match"] === hash) {
                response.writeHead(304);
                console.log(`CACHED Immutable HTTP response (${request.method}) ${url}`);
                return;
            }
        }

        requests.set(caller, request);
        let result: unknown;
        try {
            result = await performLocalCall({
                caller,
                call
            });
        } finally {
            requests.delete(caller);
        }

        let resultBuffer: Buffer;
        if (typeof result === "object" && result && result instanceof Buffer) {
            resultBuffer = result;
        } else {
            resultBuffer = Buffer.from(JSON.stringify(result));
        }

        let headers = (resultBuffer as HTTPResultType)[resultHeaders];

        // NOTE: Our ETag caching is only to reduce data sent on the wire, we evaluate the calls
        //  every time (so it is strictly a wire cache for HTTP, not a computation cache)
        if (SocketFunction.HTTP_ETAG_CACHE) {
            response.setHeader("cache-control", "private, max-age=0, must-revalidate");
            let hash = sha256Hash(resultBuffer);
            response.setHeader("ETag", hash);
            if (request.headers["if-none-match"] === hash) {
                response.writeHead(304);
                console.log(`CACHED HTTP response  ${formatNumberSuffixed(resultBuffer.length)}B  (${request.method}) ${url}`);
                return;
            }
        }

        if (headers) {
            for (let headerName in headers) {
                response.setHeader(headerName, headers[headerName]);
            }
            let status = headers["status"];
            if (status) {
                response.writeHead(+status);
                return;
            }
        }
        let uncompressedLength = resultBuffer.length;
        if (SocketFunction.HTTP_COMPRESS && request.headers["accept-encoding"]?.includes("gzip") && !headers?.["Content-Encoding"]) {
            // NOTE: This is a BIT slow. To speed it up, functions can use an internal cache, according to their function,
            //  and return a Buffer (which they can as any cast to make the returned type allowed, as returned Buffers will
            //  just be treated like a buffer of JSON data).
            //  - The caller should use getCurrentHTTPRequest first though, to check if gzip is allowed
            response.setHeader("Content-Encoding", "gzip");
            resultBuffer = await new Promise<Buffer>((resolve, reject) => {
                zlib.gzip(resultBuffer, {}, (err, result) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(result);
                    }
                });
            });
        }
        response.setHeader("Content-Length", resultBuffer.length.toString());
        if (!response.getHeader("X-Uncompressed-Content-Length")) {
            response.setHeader("X-Uncompressed-Content-Length", uncompressedLength.toString());
        }
        response.write(resultBuffer);
        if (SocketFunction.logMessages) {
            console.log(`HTTP response  ${formatNumberSuffixed(resultBuffer.length)}B  (${request.method}) ${url}`);
        }

    } catch (e: any) {
        console.log(`HTTP error  (${request.method}) ${e.stack}`);
        response.writeHead(500, String(e.message).replace(/[^\x20-\x7E]/g, ""));
    } finally {
        response.end();
    }
}


const resultHeaders = Symbol("resultHeaders");
type HTTPResultType = Buffer & { [resultHeaders]?: { [header: string]: string } };

export function setHTTPResultHeaders(
    result: HTTPResultType,
    headers: { [header: string]: string },
): HTTPResultType {
    result[resultHeaders] = headers;
    return result;
}