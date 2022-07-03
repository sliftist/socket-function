import https from "https";
import http from "http";
import net from "net";
import tls from "tls";
import { CallerContext, CallType } from "../SocketFunctionTypes";
import { performLocalCall } from "./callManager";
import { getNodeIdRaw } from "./nodeAuthentication";
import debugbreak from "debugbreak";
import * as cookie from "cookie";

const nodeIdCookie = "node-id3";

let defaultHTTPCall: CallType | undefined;

export function setDefaultHTTPCall(call: CallType) {
    defaultHTTPCall = call;
}

export function getNodeIdFromRequest(request: http.IncomingMessage): string | undefined {
    let cookies = cookie.parse(request.headers.cookie ?? "");
    return cookies[nodeIdCookie];
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
            let headerNodeId = cookie.parse(request.headers.cookie || "")[nodeIdCookie];
            if (typeof headerNodeId === "string") {
                nodeId = headerNodeId;
            }
        }
        if (!nodeId) {
            nodeId = "HTTP_nodeId_" + Date.now() + "_" + Math.random();
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
            location: {
                address,
                localPort: port,
                listeningPorts: [],
            }
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

        let call: CallType = {
            classGuid,
            functionName,
            args,
        };

        let result = await performLocalCall({
            caller,
            call
        });

        if (typeof result === "object" && result && result instanceof Buffer) {
            let headers = (result as HTTPResultType)[resultHeaders];
            if (headers) {
                for (let headerName in headers) {
                    response.setHeader(headerName, headers[headerName]);
                }
            }
            response.write(result);
        } else {
            response.write(JSON.stringify(result));
        }
        response.end();
    } catch (e: any) {
        console.error(`Request error`, e.stack);
        response.writeHead(500, String(e.message));
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