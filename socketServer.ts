import https from "https";
import http from "http";
import net from "net";
import * as ws from "ws";
import { performLocalCall } from "./callManager";
import { CallerContext, CallType, NetworkLocation } from "./SocketFunctionTypes";
import { callFactoryFromWS } from "./CallInstance";
import { registerNodeClient } from "./nodeCache";
import { getCertKeyPair } from "./nodeAuthentication";

export type SocketServerConfig = {
    port: number;
    // public sets ip to "0.0.0.0", otherwise it defaults to "127.0.0.1", which
    //  causes the server to only accept local connections.
    public?: boolean;
    ip?: string;
} & (
    https.ServerOptions
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
    let server = https.createServer({
        ...config,
        rejectUnauthorized: false,
        requestCert: true
    });
    let listenPromise = new Promise<void>((resolve, error) => {
        server.on("listening", () => {
            resolve();
        });
        server.on("error", e => {
            error(e);
        });
    });
    

    let host = config.ip ?? "127.0.0.1";
    if (config.public) {
        host = "0.0.0.0";
    }

    server.on("request", (request, response) => {
        // TODO: Handle HTTP requests
        //  - HTTP CAN have a nodeId, simply through setting cookies
        //      - Cookies could always be set via a request before we open
        //          the websocket connection?
    });

    const webSocketServer = new ws.Server({
        noServer: true,
    });
    server.on("upgrade", (request, socket, upgradeHead) => {
        webSocketServer.handleUpgrade(request, socket, upgradeHead, async (ws) => {
            let clientCallFactory = await callFactoryFromWS(ws);
            registerNodeClient(clientCallFactory);
        });
    });

    server.listen(config.port, host);

    return await listenPromise;
}