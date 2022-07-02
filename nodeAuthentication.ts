import ws from "ws";
import tls from "tls";
import { getAppFolder } from "./storagePath";
import fs from "fs";
import child_process from "child_process";
import { cacheWeak, lazy } from "./caching";
import https from "https";
import debugbreak from "debugbreak";
import crypto from "crypto";
import { sha256Hash } from "./misc";
import { getArgs } from "./args";

export const getCertKeyPair = lazy((): { key: Buffer; cert: Buffer } => {
    // TODO: Also get this working clientside...
    //  - Probably using node-forge, maybe using this as an example: https://github.com/jfromaniello/selfsigned/blob/master/index.js

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

export const getNodeId = cacheWeak(function (webSocket: ws.WebSocket): string {
    let socket = getTLSSocket(webSocket);
    let peerCert = socket.getPeerCertificate();
    if (!peerCert) {
        throw new Error("WebSocket connections must provided a peer certificate");
    }
    let pubkey = (peerCert as any).pubkey as Buffer | undefined;
    if (!pubkey) {
        throw new Error(`Peer certificate must use an RSA key or EC key (which should have a .pubkey property)`);
    }
    return sha256Hash(pubkey);
});

export function createWebsocket(address: string, port: number): ws.WebSocket {
    let { key, cert } = getCertKeyPair();
    console.log(`Connecting to ${address}:${port}`);
    return new ws.WebSocket(`wss://${address}:${port}`, {
        cert,
        key,
        rejectUnauthorized: false,
    });
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