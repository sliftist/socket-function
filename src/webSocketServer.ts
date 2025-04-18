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
import { Watchable, getRootDomain, timeInHour, timeInMinute } from "./misc";
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
         *      - Ignored if public is false (in which case we mount on 127.0.0.1, so port forwarding
         *          wouldn't matter anyways).
        */
        autoForwardPort?: boolean;
        ip?: string;

        // NOTE: Any same origin accesses are allowed (header.origin === header.host)
        // For example, to allow "letx.ca" to access the server (when the hosted domain
        //  may be, "querysub.com", for example), use ["letx.ca"]
        allowHostnames?: string[];
        // If a hostname is in allowHostnames or allowHostnameFnc returns true, it is allowed
        allowHostnameFnc?: (hostname: string) => boolean;

        /** If the SNI matches this domain, we use a different key/cert.
         *      We remove subdomains until we find a match
         */
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
            // NOTE: If this is called a lot... STOP CALLING IT A LOT! Calling setSecureContext
            //  so frequently likely leaks memory!
            console.log(`Updating websocket server options`);
            lastOptions = {
                ...value,
                ca: getTrustedCertificates(),
                // Attempt to disable sessions, because they make SNI significantly harder to parse.
                secureOptions: require("node:constants").SSL_OP_NO_TICKET,
            };
            if (!httpsServerLast) {
                httpsServerLast = https.createServer(lastOptions);
                // NOTE: This MIGHT be different than the keep alive option? Probably not, but also...
                //  something weird is happening with connections...
                httpsServerLast.keepAliveTimeout = 0;
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
            // NOTE: If this is called a lot... STOP CALLING IT A LOT! Calling setSecureContext
            //  so frequently likely leaks memory!
            console.log(`Updating websocket server trusted certificates`);
            lastOptions.ca = getTrustedCertificates();
            httpsServer.setSecureContext(lastOptions);
        });

        httpsServer.on("connection", socket => {
            let debug = (socket as any).remoteAddress + ":" + (socket as any).remotePort;
            if (!SocketFunction.silent) {
                console.log(`HTTP server connection established ${debug}`);
            }
            socket.on("error", e => {
                if (!SocketFunction.silent) {
                    console.log(`HTTP server socket error for ${debug}, ${e.message}`);
                }
            });
            socket.on("close", () => {
                if (!SocketFunction.silent) {
                    console.log(`HTTP server socket closed for ${debug}`);
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
            let originHeader = request.headers["origin"];
            if (originHeader) {
                try {
                    let host = getRootDomain(new URL("ws://" + request.headers["host"]).hostname);
                    let origin = getRootDomain(new URL(originHeader).hostname);
                    let allowed = host === origin || allowedHostnames.has(origin);
                    if (!allowed && config.allowHostnameFnc) {
                        allowed = config.allowHostnameFnc(origin);
                    }
                    if (!allowed) {
                        throw new Error(`Invalid cross domain request, ${JSON.stringify(host)} !== ${JSON.stringify(origin)} (also not in config.allowedHostnames ${JSON.stringify(config.allowHostnames)})`);
                    }
                } catch (e) {
                    // Destroy the socket, so we don't lock up the client
                    socket.destroy();
                    // NOTE: Just log, because invalid requests are guaranteed to happen, and
                    //  there's no point wasting time looking at them.
                    console.log(e);
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
        // Keep alive causes problems with our HTTP requests. AND... almost all of our data uses
        //  our websockets, so... we really don't need to keep alive our HTTP requests
        //  (and our images go through cloudflare, so we don't even need keep alive for that)
        keepAlive: false,
        keepAliveInitialDelay: 0,
        noDelay: true,
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

    let httpServer = http.createServer({ keepAlive: false, }, async function (req, res) {
        let url = new URL("http://" + req.headers.host + req.url);
        url.protocol = "https:";
        //url.hostname = opts.hostname;
        url.hostname = req.headers.host || "";
        res.writeHead(301, { Location: url + "" });
        res.end();
    });
    httpServer.keepAliveTimeout = 0;
    httpServer.on("error", e => {
        console.error(`HTTP error ${e.stack}`);
    });

    let realServer = net.createServer(socket => {
        const debug = socket.remoteAddress + ":" + socket.remotePort;
        if (!SocketFunction.silent) {
            console.log(`Received TCP connection from ${debug}`);
        }
        function handleTLSHello(buffer: Buffer, packetCount: number): void | "more" {
            if (!SocketFunction.silent) {
                console.log(`Received TCP header packet from ${debug}, have ${buffer.length} bytes so far, ${packetCount} packets`);
            }
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
                    console.log(`Received TCP connection with SNI ${JSON.stringify(sni)}. Have handlers for: ${Array.from(sniServers.keys()).join(", ")}`);
                }
                if (!sni) {
                    console.warn(`No SNI found in TLS hello from ${debug}, using main server. Packets ${packetCount}`);
                    console.log(buffer.toString("base64"));
                }
                let originalSNI = sni;
                if (sni) {
                    // Remove subdomains until we can find a domain
                    while (!sniServers.has(sni)) {
                        let parts = sni.split(".");
                        if (parts.length <= 2) break;
                        sni = parts.slice(1).join(".");
                    }
                }

                if (!sniServers.has(sni)) {
                    console.warn(`No SNI server found for ${originalSNI}, using main server. SNI candidates ${Array.from(sniServers.keys()).join(", ")}`);
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
            console.error(`TCP socket error for ${debug}, ${e.stack}`);
        });
        socket.on("close", () => {
            if (!SocketFunction.silent) {
                console.log(`TCP socket closed for ${debug}`);
            }
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
        runInfinitePollCallAtStart(timeInMinute * 30, forward).catch(e => console.error(red(`Error in port forwarding ${e.stack}`)));
    }

    let nodeId = getNodeId(getCommonName(config.cert), port);
    console.log(green(`Started Listening on ${nodeId} (${host}) after ${formatTime(process.uptime() * 1000)}`));

    return nodeId;
}

function getCommonName(cert: Buffer | string) {
    let subject = new crypto.X509Certificate(cert).subject;
    let subjectKVPs = new Map(subject.split(",").map(x => x.trim().split("=")).map(x => [x[0], x.slice(1).join("=")]));
    let commonName = subjectKVPs.get("CN");
    if (!commonName) throw new Error(`No common name in subject: ${subject}`);
    return commonName;
}
