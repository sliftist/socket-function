import https from "https";
import http from "http";
import net from "net";
import tls from "tls";
import * as ws from "ws";
import { performLocalCall } from "./callManager";
import { CallerContext, CallType, NetworkLocation } from "../SocketFunctionTypes";
import { CallFactory, callFactoryFromWS } from "./CallFactory";
import { registerNodeClient } from "./nodeCache";
import { getCertKeyPair, getNodeId, getNodeIdRaw } from "./nodeAuthentication";
import debugbreak from "debugbreak";
import { cache } from "./caching";
import { getNodeIdFromRequest, getServerLocationFromRequest, httpCallHandler } from "./callHTTPHandler";
import { SocketFunction } from "../SocketFunction";

// TODO: Support conditional peer certificate requests, as it the certificate prompt
//  seems suspicious in the browser (the user can just click cancel though).

export type SocketServerConfig = (
    {
        port: number;
        // public sets ip to "0.0.0.0", otherwise it defaults to "127.0.0.1", which
        //  causes the server to only accept local connections.
        public?: boolean;
        ip?: string;
    } & (
        https.ServerOptions
    )
);

export async function startSocketServer(
    config: SocketServerConfig
) {
    let isSecure = "cert" in config || "key" in config || "pfx" in config;
    if (!isSecure) {
        let { key, cert } = getCertKeyPair();
        config.key = key;
        config.cert = cert;
    }

    // TODO: Only allow unauthorized for ip certificates, and then for domains use the domain as the nodeId,
    //  so it is easy to read, and consistent.
    let httpsServer = https.createServer({
        ...config,
        rejectUnauthorized: SocketFunction.rejectUnauthorized,
        requestCert: true,
        ca: tls.rootCertificates.concat(SocketFunction.additionalTrustedRootCAs),
    });
    httpsServer.on("connection", socket => {
        console.log("Client connection established");
    });
    httpsServer.on("error", e => {
        console.error(`Connection attempt error ${e.message}`);
    });
    httpsServer.on("tlsClientError", e => {
        console.error(`TLS client error ${e.message}`);
    });


    httpsServer.on("request", httpCallHandler);

    const webSocketServer = new ws.Server({
        noServer: true,
    });
    httpsServer.on("upgrade", (request, socket, upgradeHead) => {
        let originHeader = request.headers["origin"];
        if (originHeader) {
            try {
                let host = new URL("ws://" + request.headers["host"]).hostname;
                let origin = new URL(originHeader).hostname;
                if (host !== origin) {
                    throw new Error(`Invalid cross thread request, ${JSON.stringify(host)} !== ${JSON.stringify(origin)}`);
                }
            } catch (e) {
                console.error(e);
                return;
            }
        }
        webSocketServer.handleUpgrade(request, socket, upgradeHead, async (ws) => {
            // NOTE: For the browser, the request will likely have a nodeId, from making an HTTP request.
            //  We would prefer peer certificates, so this isn't the default (in getNodeId), but it will
            //  likely be used most of the time.
            let requestNodeId = getNodeIdFromRequest(request);
            Object.assign(ws, { nodeId: requestNodeId });

            let clientCallFactory = await callFactoryFromWS(ws, getServerLocationFromRequest(request));
            registerNodeClient(clientCallFactory);
        });
    });

    let httpServer = http.createServer({}, async function (req, res) {
        let url = new URL("http://" + req.headers.host + req.url);
        url.protocol = "https:";
        //url.hostname = opts.hostname;
        url.hostname = req.headers.host || "";
        res.writeHead(301, { Location: url + "" });
        res.end();
    });

    let realServer = net.createServer(socket => {
        // NOTE: ONCE is used, so we only look at the first buffer, and then after that
        //  we pipe. This should be very efficient, as pipe has insane throughput
        //  (100s of MB/s, easily, even on a terrible machine).
        socket.once("data", buffer => {
            // All HTTPS requests start with 22, and no HTTP requests start with 22,
            //  so we just need to read the first byte.
            let server = buffer[0] === 22 ? httpsServer : httpServer;

            // NOTE: Messages aren't dequeued until the current handler finishes, so we don't need to pause the socket or anything.
            server.emit("connection", socket);
            socket.unshift(buffer);
        });
        socket.on("error", (e) => {
            console.error(`Exposed socket error, ${e.stack}`);
        });
    });


    let listenPromise = new Promise<void>((resolve, error) => {
        realServer.on("listening", () => {
            resolve();
        });
        realServer.on("error", e => {
            error(e);
        });
    });


    let host = config.ip ?? "127.0.0.1";
    if (config.public) {
        host = "0.0.0.0";
    }

    console.log(`Trying to listening on ${host}:${config.port}`);
    realServer.listen(config.port, host);

    await listenPromise;

    console.log(`Started Listening on ${host}:${config.port}`);
}