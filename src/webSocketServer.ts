import https from "https";
import http from "http";
import net from "net";
import tls from "tls";
import * as ws from "ws";
import { getNodeIdsFromRequest, httpCallHandler } from "./callHTTPHandler";
import { SocketFunction } from "../SocketFunction";
import { getTrustedCertificates, watchTrustedCertificates } from "./certStore";
import { createCallFactory } from "./CallFactory";
import { parseSNIExtension, parseTLSHello, SNIType } from "./tlsParsing";
import debugbreak from "debugbreak";

export type SocketServerConfig = (
    https.ServerOptions & {
        nodeId?: string;

        key: string | Buffer;
        cert: string | Buffer;

        port: number;

        // public sets ip to "0.0.0.0", otherwise it defaults to "127.0.0.1", which
        //  causes the server to only accept local connections.
        public?: boolean;
        ip?: string;

        /** If the SNI matches this domain, we use a different key/cert. */
        SNICerts?: {
            [domain: string]: https.ServerOptions;
        };
    }
);

export async function startSocketServer(
    config: SocketServerConfig
): Promise<void> {

    const webSocketServer = new ws.Server({
        noServer: true,
    });

    function setupHTTPSServer(options: https.ServerOptions) {
        let httpsServer = https.createServer(options);
        watchTrustedCertificates(() => {
            options.ca = getTrustedCertificates();
            httpsServer.setSecureContext(options);
        });

        httpsServer.on("connection", socket => {
            console.log("Client connection established");
            socket.on("error", e => {
                console.log(`Client socket error ${e.message}`);
            });
            socket.on("close", () => {
                console.log("Client socket closed");
            });
        });
        httpsServer.on("error", e => {
            console.error(`Connection attempt error ${e.message}`);
        });
        httpsServer.on("tlsClientError", e => {
            console.error(`TLS client error ${e.message}`);
        });

        httpsServer.on("request", httpCallHandler);

        httpsServer.on("upgrade", (request, socket, upgradeHead) => {
            socket.on("error", e => {
                console.log(`Client socket error ${e.message}`);
            });

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
            webSocketServer.handleUpgrade(request, socket, upgradeHead, (ws) => {
                const { nodeId, localNodeId } = getNodeIdsFromRequest(request);
                createCallFactory(ws, nodeId, localNodeId).catch(e => {
                    console.error(`Error in creating call factory, ${e.stack}`);
                });
            });
        });
        return httpsServer;
    }

    // TODO: Only allow unauthorized for ip certificates, and then for domains use the domain as the nodeId,
    //  so it is easy to read, and consistent.
    let options: https.ServerOptions = {
        ...config,
    };

    const mainHTTPSServer = setupHTTPSServer(options);
    let sniServers = new Map<string, https.Server>();
    for (let [domain, obj] of Object.entries(config.SNICerts || {})) {
        sniServers.set(domain, setupHTTPSServer(obj));
    }

    let httpServer = http.createServer({}, async function (req, res) {
        let url = new URL("http://" + req.headers.host + req.url);
        url.protocol = "https:";
        //url.hostname = opts.hostname;
        url.hostname = req.headers.host || "";
        res.writeHead(301, { Location: url + "" });
        res.end();
    });
    httpServer.on("error", e => {
        console.error(`HTTP error ${e.stack}`);
    });

    let realServer = net.createServer(socket => {
        // NOTE: ONCE is used, so we only look at the first buffer, and then after that
        //  we pipe. This should be very efficient, as pipe has insane throughput
        //  (100s of MB/s, easily, even on a terrible machine).
        socket.once("data", buffer => {
            // All HTTPS requests start with 22, and no HTTP requests start with 22,
            //  so we just need to read the first byte.

            let server: https.Server | http.Server;
            if (buffer[0] !== 22) {
                server = httpServer;
            } else {
                let data = parseTLSHello(buffer);
                let sni = data.extensions.filter(x => x.type === SNIType).flatMap(x => parseSNIExtension(x.data))[0];
                server = sniServers.get(sni) || mainHTTPSServer;
            }

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

    let port = (realServer.address() as net.AddressInfo).port;

    console.log(`Started Listening on ${config.nodeId || host}:${port}`);
}