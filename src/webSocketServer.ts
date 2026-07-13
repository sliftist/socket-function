import https from "https";
import http from "http";
import net from "net";
import tls from "tls";
import { getNodeIdsFromRequest, httpCallHandler } from "./callHTTPHandler";
import { chooseProtocol, decodeProtocol } from "./protocolNegotiation";
import { SocketFunction } from "../SocketFunction";
import { getTrustedCertificates, watchTrustedCertificates } from "./certStore";
import { createCallFactory } from "./CallFactory";
import { parseSNIExtension, parseTLSHello, SNIType } from "./tlsParsing";
import debugbreak from "debugbreak";
import { getNodeId } from "./nodeCache";
import crypto from "crypto";
import { Watchable, getRootDomain, timeInHour, timeInMinute } from "./misc";
import { delay, runInfinitePoll } from "./batching";
import { magenta, red } from "./formatting/logColors";
import { yellow } from "./formatting/logColors";
import { green } from "./formatting/logColors";
import { formatTime } from "./formatting/format";
import { getExternalIP, testTCPIsListening } from "./networking";
import { forwardPort, listPortMappings, getLocalInternalIP, PortMapping } from "./forwardPort";
import os from "os";

// When a requested port is taken and useAvailablePortIfPortInUse is set, we scan
//  upwards from this base instead of binding a random OS-assigned port, so restarts
//  land on predictable, consistent ports.
const PORT_SCAN_START = 13000;
const PORT_SCAN_COUNT = 10000;

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
    const ws = await import("ws");

    const webSocketServer = new ws.Server({
        noServer: true,
        // Negotiate connection-level flags via Sec-WebSocket-Protocol. The
        // client proposes hex-encoded values that include the target nodeId;
        // we accept only those whose target matches OUR identity
        // (SocketFunction.mountedNodeId — not the address the client used to
        // reach us). If none match we return false, which rejects the
        // handshake — exactly the semantics we want (indistinguishable from
        // "node not reachable"). If the client sent no Sec-WebSocket-Protocol
        // at all, this callback isn't invoked and the handshake proceeds as
        // a legacy client.
        handleProtocols: (protocols, request) => {
            const ourNodeId = SocketFunction.mountedNodeId;
            const proposed = Array.from(protocols);
            const chosen = chooseProtocol(proposed, ourNodeId, { lz4: true });
            if (!chosen) {
                const proposedDecoded = proposed.map(p => decodeProtocol(p));
                let target = proposedDecoded[0]?.target;
                let getMachineId = (x: string) => x.split(".").slice(-3).join(".");
                if (target && getMachineId(target) === getMachineId(ourNodeId)) {
                    console.log(`Rejecting handshake from old thread, ${target} !== ${ourNodeId}`);
                } else {
                    console.log(`Rejecting handshake on ${ourNodeId}: none of the ${proposed.length} proposed protocols target us`, { ourNodeId, proposedDecoded });
                }
                return false;
            }
            return chosen;
        },
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
            // NOTE: If this is called a lot... STOP CALLING IT A LOT! Calling setSecureContext frequently leaks memory! (As in, once a minute is maybe too much, once a second is definitely too much)
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

                if (!sniServers.has(sni) && sniServers.size > 0) {
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
                if (typeof buffer === "string") {
                    buffer = Buffer.from(buffer);
                }
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
        console.log(yellow(`Trying to listen on ${host}:${port}`));
    }

    // Attempts to bind realServer to a single port. Resolves true once the server is
    //  actually listening, false if the port is already in use, and rejects on any
    //  other error. After an EADDRINUSE the server is still usable, so the caller can
    //  simply retry listen() on the next candidate.
    async function tryListen(candidatePort: number): Promise<boolean> {
        return await new Promise<boolean>((resolve, reject) => {
            function cleanup() {
                realServer.removeListener("error", onError);
                realServer.removeListener("listening", onListening);
            }
            function onError(e: NodeJS.ErrnoException) {
                cleanup();
                if (e.code === "EADDRINUSE" || e.message.includes("EADDRINUSE")) {
                    resolve(false);
                } else {
                    reject(e);
                }
            }
            function onListening() {
                cleanup();
                resolve(true);
            }
            realServer.once("error", onError);
            realServer.once("listening", onListening);
            realServer.listen(candidatePort, host);
        });
    }

    // Frees the currently-bound listening socket so we can rebind on a different port
    //  (used when a locally-free port turns out to be unusable for forwarding).
    async function releasePort(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            if (!realServer.listening) {
                resolve();
                return;
            }
            realServer.close(e => e ? reject(e) : resolve());
        });
    }

    // Forwarding maps the external port to an equal internal port, so a candidate is only
    //  usable if we can also own its external mapping on the router. Skipped on linux,
    //  where forwardPort is a no-op anyway.
    const doForward = !!(config.autoForwardPort && config.public && os.platform() !== "linux");

    // Ensures the router's external mapping for `externalPort` belongs to us. Returns true
    //  if it's ours to keep (existing-and-ours → refresh the lease; free → create and
    //  confirm we won it), false if another machine owns it and we should try a new port.
    async function claimPortForward(externalPort: number): Promise<boolean> {
        const ourIP = getLocalInternalIP();
        const matches = (m: PortMapping) => m.externalPort === externalPort && m.protocol.toUpperCase() === "TCP";

        const existing = (await listPortMappings()).find(matches);
        if (existing) {
            if (ourIP && existing.internalClient === ourIP) {
                await forwardPort({ externalPort, internalPort: externalPort });
                return true;
            }
            console.log(magenta(`External port ${externalPort} is already forwarded to ${existing.internalClient}, trying another port`));
            return false;
        }

        // Free right now — create the mapping, then re-read it to make sure another host
        //  didn't grab the same external port in the race between our list and our create.
        await forwardPort({ externalPort, internalPort: externalPort });
        const ours = (await listPortMappings()).find(matches);
        if (!ours || (ourIP && ours.internalClient !== ourIP)) {
            console.log(magenta(`Failed to claim external port ${externalPort} (now ${ours ? `forwarded to ${ours.internalClient}` : "still unmapped"}), trying another port`));
            return false;
        }
        return true;
    }

    // Candidate ports: an explicitly requested port first (a falsy port, the default 0,
    //  means "no preference"), then a consistent upward scan so restarts are predictable.
    function* candidatePorts(): Generator<number> {
        if (port) yield port;
        for (let candidate = PORT_SCAN_START; candidate < PORT_SCAN_START + PORT_SCAN_COUNT; candidate++) {
            if (candidate === port) continue;
            yield candidate;
        }
    }

    let bound = false;
    for (const candidate of candidatePorts()) {
        if (!await tryListen(candidate)) {
            if (candidate === config.port && !config.useAvailablePortIfPortInUse) {
                throw new Error(`Port ${candidate} is already in use (set useAvailablePortIfPortInUse to fall back to another port)`);
            }
            continue;
        }
        // Locally bound. If we also forward, the external mapping must be ours too, or we
        //  release this port and keep scanning.
        if (doForward) {
            let claimed: boolean;
            try {
                claimed = await claimPortForward(candidate);
            } catch (e) {
                // UPnP unavailable (no gateway / discovery failed): fall back to best-effort
                //  forwarding rather than refusing to start.
                console.error(red(`Could not verify forwarding for port ${candidate}, continuing best-effort: ${(e as Error).stack}`));
                claimed = true;
            }
            if (!claimed) {
                await releasePort();
                continue;
            }
        }
        port = candidate;
        bound = true;
        break;
    }
    if (!bound) {
        throw new Error(`Could not find an available port in range ${PORT_SCAN_START}-${PORT_SCAN_START + PORT_SCAN_COUNT - 1} (requested ${config.port})`);
    }

    port = (realServer.address() as net.AddressInfo).port;

    if (doForward) {
        // The mapping is claimed above; keep refreshing the lease so it doesn't expire.
        async function refreshForward() {
            await forwardPort({ externalPort: port, internalPort: port });
            console.log(magenta(`Refreshed port forward ${port} to our machine`));
        }
        runInfinitePoll(timeInMinute * 30, refreshForward);
    }

    let nodeId = getNodeId(getCommonName(config.cert), port);
    console.log(green(`Started Listening on ${nodeId} (${host}) after ${formatTime(process.uptime() * 1000)}`), {
        domains: Object.keys(config.SNICerts || {}),
    });

    return nodeId;
}

function getCommonName(cert: Buffer | string) {
    let subject = new crypto.X509Certificate(cert).subject;
    let subjectKVPs = new Map(subject.split(",").map(x => x.trim().split("=")).map(x => [x[0], x.slice(1).join("=")]));
    let commonName = subjectKVPs.get("CN");
    if (!commonName) throw new Error(`No common name in subject: ${subject}`);
    return commonName;
}
