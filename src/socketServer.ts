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
import { getNodeIdFromRequest, httpCallHandler } from "./callHTTPHandler";

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
        rejectUnauthorized: false,
        requestCert: true,
    });


    httpsServer.on("request", httpCallHandler);

    const webSocketServer = new ws.Server({
        noServer: true,
    });
    httpsServer.on("upgrade", (request, socket, upgradeHead) => {
        webSocketServer.handleUpgrade(request, socket, upgradeHead, async (ws) => {
            // NOTE: For the browser, the request will likely have a nodeId, from making an HTTP request.
            //  We would prefer peer certificates, so this isn't the default (in getNodeId), but it will
            //  likely be used most of the time.
            let requestNodeId = getNodeIdFromRequest(request);
            Object.assign(ws, { nodeId: requestNodeId });

            let clientCallFactory = await callFactoryFromWS(ws);
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

    httpServer.listen(0, "127.0.0.1");
    httpsServer.listen(0, "127.0.0.1");

    // TODO: We should really add error handling here, but... we should always be able to listen
    //  on ANY port on localhost, as why couldn't we?
    let httpServerReady = new Promise(resolve => httpServer.once("listening", resolve));
    let httpsServerReady = new Promise(resolve => httpsServer.once("listening", resolve));
    await httpServerReady;
    await httpsServerReady;

    let httpAddress = httpServer.address() as net.AddressInfo;
    let httpsAddress = httpsServer.address() as net.AddressInfo;


    let realServer = net.createServer(socket => {
        // NOTE: ONCE is used, so we only look at the first buffer, and then after that
        //  we pipe. This should be very efficient, as pipe has insane throughput
        //  (100s of MB/s, easily, even on a terrible machine).
        socket.once("data", buffer => {
            // All HTTPS requests start with 22, and no HTTP requests start with 22,
            //  so we just need to read the first byte.
            let byte = buffer[0];
            let isHTTPS = byte === 22;
            let address = httpAddress;
            if (isHTTPS) {
                address = httpsAddress;
            }
            let baseSocket = net.connect(address.port);

            baseSocket.write(buffer);
            socket.pipe(baseSocket);
            baseSocket.pipe(socket);

            baseSocket.on("error", (e) => {
                console.error(`Base socket error, ${e.stack}`);
            });
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