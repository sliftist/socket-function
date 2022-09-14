import https from "https";
import http from "http";
import net from "net";
import tls from "tls";
import { CallerContext, CallType, NetworkLocation, setCertInfo } from "../SocketFunctionTypes";
import { isDataImmutable, performLocalCall } from "./callManager";
import { getNodeIdRaw } from "./nodeAuthentication";
import debugbreak from "debugbreak";
import * as cookie from "cookie";
import { SocketFunction } from "../SocketFunction";
import { gzip } from "zlib";
import { formatNumberSuffixed, sha256Hash } from "./misc";

const nodeIdCookie = "node-id4";

let defaultHTTPCall: CallType | undefined;

export function setDefaultHTTPCall(call: CallType) {
    defaultHTTPCall = call;
}

const cookieNodeIdPrefix = "COOKIE_nodeId_";
export function getNodeIdFromRequest(request: http.IncomingMessage): string | undefined {
    let cookies = cookie.parse(request.headers.cookie ?? "");
    let value = cookies[nodeIdCookie];
    if (!value) return value;
    if (!value.startsWith(cookieNodeIdPrefix)) return undefined;
    return value;
}
export function getServerLocationFromRequest(request: http.IncomingMessage): NetworkLocation {
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
        listeningPorts: [port],
    };
}

export async function httpCallHandler(request: http.IncomingMessage, response: http.ServerResponse) {
    try {

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

        console.log(`HTTP request (${request.method}) ${url}`);
        let urlObj = new URL(url);

        let payload = await new Promise<Buffer>((resolve, reject) => {
            let data: Buffer[] = [];
            request
                .on("data", chunk => data.push(chunk))
                .on("end", () => resolve(Buffer.concat(data)))
                .on("error", (err) => reject(err))
                ;
        });

        let socket = request.connection as tls.TLSSocket;

        let address = socket.remoteAddress;
        let port = socket.remotePort;
        if (!address) {
            throw new Error("Missing remote address");
        }
        if (!port) {
            throw new Error("Missing remote port");
        }

        let nodeId = getNodeIdRaw(socket);
        if (!nodeId) {
            let cookieNodeId = getNodeIdFromRequest(request);
            if (typeof cookieNodeId === "string") {
                nodeId = cookieNodeId;
            }
        }
        if (!nodeId) {
            nodeId = cookieNodeIdPrefix + Date.now() + "_" + Math.random();
            response.setHeader("Set-Cookie", cookie.serialize(nodeIdCookie, nodeId, {
                httpOnly: true,
                path: "/",
                secure: true,
                domain: urlObj.hostname,
                sameSite: "none"
            }));

            response.setHeader(nodeIdCookie, nodeId);
        }

        let caller: CallerContext = {
            nodeId,
            fromPort: port,
            location: {
                address,
                listeningPorts: [],
            },
            serverLocation: getServerLocationFromRequest(request),
            certInfo: undefined,
        };
        setCertInfo(socket, caller);

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

        let call: CallType = {
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

        let result = await performLocalCall({
            caller,
            call
        });

        let resultBuffer: Buffer;
        if (typeof result === "object" && result && result instanceof Buffer) {
            resultBuffer = result;
        } else {
            resultBuffer = Buffer.from(JSON.stringify(result));
        }

        let headers = (resultBuffer as HTTPResultType)[resultHeaders];
        if (SocketFunction.compression?.type === "gzip" && !headers?.["Content-Encoding"]) {
            if (request.headers["accept-encoding"]?.includes("gzip")) {
                resultBuffer = await new Promise<Buffer>((resolve, reject) =>
                    gzip(resultBuffer, (err, result) => err ? reject(err) : resolve(result))
                );
                response.setHeader("Content-Encoding", "gzip");
            }
        }


        // NOTE: Our ETag caching is only to reduce data sent on the wire, we evaluate the calls
        //  every time (so it is strictly a wire cache, not a computation cache)
        if (SocketFunction.httpETagCache) {
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
        response.write(resultBuffer);
        console.log(`HTTP response  ${formatNumberSuffixed(resultBuffer.length)}B  (${request.method}) ${url}`);

    } catch (e: any) {
        console.log(`HTTP error  (${request.method}) ${e.stack}`);
        response.writeHead(500, String(e.message));
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