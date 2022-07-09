import ws from "ws";
import tls from "tls";
import net from "net";
import { getAppFolder } from "./storagePath";
import fs from "fs";
import child_process from "child_process";
import { cacheWeak, lazy } from "./caching";
import https from "https";
import debugbreak from "debugbreak";
import crypto from "crypto";
import { isNode, sha256Hash } from "./misc";
import { getArgs } from "./args";
import { SenderInterface } from "./CallFactory";

export const getCertKeyPair = lazy((): { key: Buffer; cert: Buffer } => {
    // TODO: Also get this working clientside...
    //  - Probably using node-forge, maybe using this as an example: https://github.com/jfromaniello/selfsigned/blob/master/index.js
    //  - ALSO, get our nodeId set in our cookies, so HTTP requests can work as well
    //      - We will need to call some kind of endpoint to do this?
    //  - Then download the certs and try to get the user to install them, so chrome can use
    //      them? Otherwise there is no point of having certs clientside.

    // https://nodejs.org/en/knowledge/HTTP/servers/how-to-create-a-HTTPS-server/

    let folder = getAppFolder();
    let identityPrefix = getArgs().identity || "";
    let keyPath = folder + identityPrefix + "key.pem";
    let certPath = folder + identityPrefix + "cert.pem";
    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
        child_process.execSync(`openssl genrsa -out "${keyPath}"`);
        child_process.execSync(`openssl req -new -key "${keyPath}" -out csr.pem -subj "/CN=notused"`);
        child_process.execSync(`openssl x509 -req -days 9999 -in csr.pem -signkey "${keyPath}" -out "${certPath}"`);
        fs.rmSync("csr.pem");
    }

    let key = fs.readFileSync(keyPath);
    let cert = fs.readFileSync(certPath);
    return { key, cert };
});

export function getTLSSocket(webSocket: ws.WebSocket) {
    return (webSocket as any)._socket as tls.TLSSocket;
}

export async function getOwnNodeId() {
    if (!isNode()) {
        throw new Error(`Clientside nodeIds are not exposed to the client`);
    }

    // This is BASICALLY just sha256Hash(getCertKeyPari().cert), however... I'm not 100% the format
    //  is the same, we would have to verify it. It isn't that important, other nodes know our nodeId,
    //  and clients don't really have a reason to use this anyway (they can't verify it, they can only
    //  really verify with a location).
    throw new Error(`TODO: Implement getOwnNodeId`);
}

export const getNodeId = cacheWeak(function (webSocket: SenderInterface | ws.WebSocket & { nodeId?: string }): string {
    if (!(webSocket instanceof ws.WebSocket)) {
        if (!webSocket.nodeId) {
            throw new Error("Sender isn't a WebSocket, and doesn't have a nodeId");
        }
        return webSocket.nodeId;
    }
    let socket = getTLSSocket(webSocket);
    let nodeId = getNodeIdRaw(socket);
    if (!nodeId) {
        if (webSocket.nodeId) {
            return webSocket.nodeId;
        }
        throw new Error(`Missing nodeId. If it is from the browser, this likely means your websocket and HTTP request are using different domains (so the cookies are lost). If it is from NodeJs peer certificate must use an RSA key or EC key (which should have a .pubkey property)`);
    }
    return nodeId;
});

export function getNodeIdRaw(socket: tls.TLSSocket) {
    let peerCert = socket.getPeerCertificate();
    if (!peerCert) {
        throw new Error("WebSocket connections must provided a peer certificate");
    }
    let pubkey = (peerCert as any).pubkey as Buffer | undefined;
    if (!pubkey) {
        return undefined;
    }
    return sha256Hash(pubkey);
}

export function createWebsocket(address: string, port: number): SenderInterface {
    console.log(`Connecting to ${address}:${port}`);
    if (!isNode()) {
        // NOTE: We assume an HTTP request has already been made, which will setup a nodeId cookie
        //  (And as this point we can't even use peer certificates if we wanted to, as this must be done
        //      directly in the browser)
        let webSocket = new WebSocket(`wss://${address}:${port}`);
        return Object.assign(webSocket, {
            on(event: string, callback: any) {
                // TODO: Use better type safety here
                (webSocket as any)["on" + event] = callback;
                return this as any;
            },
        });
    } else {
        let { key, cert } = getCertKeyPair();
        return new ws.WebSocket(`wss://${address}:${port}`, {
            cert,
            key,
            rejectUnauthorized: false,
        });
    }
}



/*
const port = 2422;
let { key, cert } = getCertKeyPair();
console.log(process.argv);
if (process.argv.includes("--server")) {
    
    let server = https.createServer({
        key,
        cert,
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
        webSocketServer.handleUpgrade(request, socket, upgradeHead, (ws) => {
            console.log("peer", getTLSSocket(ws).getPeerCertificate()?.pubkey.toString("hex").slice(100));
            console.log("cert", getTLSSocket(ws).getCertificate()?.pubkey.toString("hex").slice(100));
        });
    });

    server.listen(2422, "127.0.0.1");
} else {
    let socket = new ws.WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false, cert, key });
    socket.on("open", () => {
        console.log("peer", getTLSSocket(socket).getPeerCertificate()?.pubkey.toString("hex").slice(100));
        console.log("cert", getTLSSocket(socket).getCertificate()?.pubkey.toString("hex").slice(100));
    });
}
*/