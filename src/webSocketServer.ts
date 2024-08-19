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
import { getNodeId } from "./nodeCache";
import crypto from "crypto";
import { Watchable, timeInHour } from "./misc";
import { delay, runInfinitePoll, runInfinitePollCallAtStart } from "./batching";
import { magenta, red } from "./formatting/logColors";
import { yellow } from "./formatting/logColors";
import { green } from "./formatting/logColors";
import { formatTime } from "./formatting/format";
import { getExternalIP, testTCPIsListening } from "./networking";
import { forwardPort } from "./forwardPort";

export type SocketServerConfig = (
    https.ServerOptions & {
        key: string | Buffer;
        cert: string | Buffer;

        port: number;
        /** You can also set `port: 0` if you don't care what port you want at all.  */
        useAvailablePortIfPortInUse?: boolean;

        // public sets ip to "0.0.0.0", otherwise it defaults to "127.0.0.1", which
        //  causes the server to only accept local connections.
        public?: boolean;
        /** Tries forwarding ports (using UPnP), if we detect they aren't externally reachable.
         *      - This causes an extra request and delay during startup, so should only be used
         *          during development.
         *      - Ignored if public is false
        */
        autoForwardPort?: boolean;
        ip?: string;

        // NOTE: Any same origin accesses are allowed (header.origin === header.host)
        // For example, to allow "letx.ca" to access the server (when the hosted domain
        //  may be, "querysub.com", for example), use ["letx.ca"]
        allowHostnames?: string[];

        /** If the SNI matches this domain, we use a different key/cert. */
        SNICerts?: {
            [domain: string]: Watchable<https.ServerOptions>;
        };
    }
);

export async function startSocketServer(
    config: SocketServerConfig
): Promise<string> {

    const webSocketServer = new ws.Server({
        noServer: true,
    });

    async function setupHTTPSServer(watchOptions: Watchable<https.ServerOptions>) {
        let httpsServerLast: https.Server | undefined;
        let onHttpServer: (server: https.Server) => void;
        let httpServerPromise = new Promise<https.Server>(r => onHttpServer = r);
        let lastOptions!: https.ServerOptions;
        await watchOptions(value => {
            lastOptions = {
                ...value,
                ca: getTrustedCertificates(),
                // Attempt to disable sessions, because they make SNI significantly harder to parse.
                secureOptions: require("node:constants").SSL_OP_NO_TICKET,
            };
            if (!httpsServerLast) {
                httpsServerLast = https.createServer(lastOptions);
            } else {
                httpsServerLast.setSecureContext(lastOptions);
            }
            onHttpServer(httpsServerLast);
        });
        let httpsServer = await httpServerPromise;

        let allowedHostnames = new Set<string>();
        for (let hostname of config.allowHostnames || []) {
            allowedHostnames.add(hostname);
        }

        watchTrustedCertificates(() => {
            lastOptions.ca = getTrustedCertificates();
            httpsServer.setSecureContext(lastOptions);
        });

        httpsServer.on("connection", socket => {
            if (!SocketFunction.silent) {
                console.log("Client connection established");
            }
            socket.on("error", e => {
                if (!SocketFunction.silent) {
                    console.log(`Client socket error ${e.message}`);
                }
            });
            socket.on("close", () => {
                if (!SocketFunction.silent) {
                    console.log("Client socket closed");
                }
            });
        });
        httpsServer.on("error", e => {
            console.error(`Connection attempt error ${e.message}`);
        });
        httpsServer.on("tlsClientError", e => {
            // NOTE: This happens a lot when we have tabs open that connected to an old
            //  server (with old certs, that the browser will reject?)
            if (!SocketFunction.silent) {
                console.error(`TLS client error ${e.message}`);
            }
        });

        httpsServer.on("request", httpCallHandler);

        httpsServer.on("upgrade", (request, socket, upgradeHead) => {
            socket.on("error", e => {
                if (!SocketFunction.silent) {
                    console.log(`Client socket error ${e.message}`);
                }
            });

            let originHeader = request.headers["origin"];
            if (originHeader) {
                try {
                    let host = new URL("ws://" + request.headers["host"]).hostname;
                    let origin = new URL(originHeader).hostname;
                    if (host !== origin && !allowedHostnames.has(origin)) {
                        throw new Error(`Invalid cross domain request, ${JSON.stringify(host)} !== ${JSON.stringify(origin)} (also not in config.allowedHostnames ${JSON.stringify(config.allowHostnames)})`);
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
    if (!config.cert) {
        throw new Error("No cert specified");
    }
    if (!config.key) {
        throw new Error("No key specified");
    }

    const mainHTTPSServer = await setupHTTPSServer(callback => callback(options));
    let sniServers = new Map<string, https.Server>();
    for (let [domain, obj] of Object.entries(config.SNICerts || {})) {
        sniServers.set(domain, await setupHTTPSServer(obj));
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
        function handleTLSHello(buffer: Buffer, packetCount: number): void | "more" {
            // All HTTPS requests start with 22, and no HTTP requests start with 22,
            //  so we just need to read the first byte.
            let server: https.Server | http.Server;
            if (buffer[0] !== 22) {
                server = httpServer;
            } else {
                let data = parseTLSHello(buffer);
                if (data.missingBytes > 0) {
                    return "more";
                }
                let sni = data.extensions.filter(x => x.type === SNIType).flatMap(x => parseSNIExtension(x.data))[0];
                if (!SocketFunction.silent) {
                    console.log(`Received TCP connection with SNI ${JSON.stringify(sni)}`);
                }
                if (!sni) {
                    console.warn(`No SNI found in TLS hello from ${socket.remoteAddress}, using main server. Packets ${packetCount}`);
                    console.log(buffer.toString("base64"));
                }
                server = sniServers.get(sni) || mainHTTPSServer;
            }

            // NOTE: Messages aren't dequeued until the current handler finishes, so we don't need to pause the socket or anything.
            server.emit("connection", socket);
            socket.unshift(buffer);
        }
        let buffers: Buffer[] = [];
        function getNextData() {
            // NOTE: ONCE is used, so we only look at the first buffer, and then after that
            //  we pipe. This should be very efficient, as pipe has insane throughput
            //  (100s of MB/s, easily, even on a terrible machine).
            socket.once("data", buffer => {
                buffers.push(buffer);
                let result = handleTLSHello(Buffer.concat(buffers), buffers.length);
                if (result === "more") {
                    getNextData();
                }
            });
        }
        getNextData();
        socket.on("error", (e) => {
            console.error(`Exposed socket error, ${e.stack}`);
        });
    });


    let host = config.public ? "0.0.0.0" : "127.0.0.1";
    if (config.ip) {
        host = config.ip;
    }

    let port = config.port;
    if (!SocketFunction.silent) {
        console.log(yellow(`Trying to listening on ${host}:${port}`));
    }

    let listeningPromise = waitUntilListening();
    listeningPromise.catch(e => { });

    // Return true if we are listening, false if the address is in use, and throws on other errors
    async function waitUntilListening() {
        return await new Promise<boolean>((resolve, reject) => {
            realServer.once("error", e => {
                reject(e);
            });
            realServer.once("listening", () => {
                resolve(false);
            });
        });
    }

    if (config.useAvailablePortIfPortInUse && port) {
        realServer.listen(port, host);
        let isListening = await new Promise<boolean>((resolve, reject) => {
            if (realServer.listening) {
                resolve(true);
                return;
            }
            realServer.once("error", e => {
                if (e.message.includes("EADDRINUSE")) {
                    resolve(true);
                } else {
                    reject(e);
                }
            });
            realServer.once("listening", () => {
                resolve(false);
            });
        });
        if (!isListening) {
            port = 0;
            realServer.listen(port, host);
            listeningPromise = waitUntilListening();
        }
    } else {
        realServer.listen(port, host);
    }

    await listeningPromise;
    port = (realServer.address() as net.AddressInfo).port;

    if (config.autoForwardPort && config.public) {
        // let externalIP = await getExternalIP();
        // let isListening = await testTCPIsListening(externalIP, port);
        // if (!isListening) {
        //     console.log(magenta(`Port ${port} is not externally reachable, trying to forward it`));
        //     await forwardPort({ externalPort: port, internalPort: port });
        // }
        // Even if they are listening, they might not stay listening. Forward every 8 hours
        //      (including at the start, in case the forward is about to expire).
        async function forward() {
            await forwardPort({ externalPort: port, internalPort: port });
            console.log(magenta(`Forwarded port ${port} to our machine`));
        }
        // Every hour, in case our network configuration changes
        runInfinitePollCallAtStart(timeInHour * 1, forward).catch(e => console.error(red(`Error in port forwarding ${e.stack}`)));
    }

    let nodeId = getNodeId(getCommonName(config.cert), port);
    console.log(green(`Started Listening on ${nodeId} after ${formatTime(process.uptime() * 1000)}`));

    return nodeId;
}

function getCommonName(cert: Buffer | string) {
    let subject = new crypto.X509Certificate(cert).subject;
    let subjectKVPs = new Map(subject.split(",").map(x => x.trim().split("=")).map(x => [x[0], x.slice(1).join("=")]));
    let commonName = subjectKVPs.get("CN");
    if (!commonName) throw new Error(`No common name in subject: ${subject}`);
    return commonName;
}