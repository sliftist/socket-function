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
import { SocketFunction } from "../SocketFunction";

let certKeyPairOverride: { key: Buffer; cert: Buffer } | undefined;
export function getCertKeyPair(): { key: Buffer; cert: Buffer } {
    if (certKeyPairOverride) return certKeyPairOverride;
    return getCertKeyPairBase();
}
const getCertKeyPairBase = lazy((): { key: Buffer; cert: Buffer } => {
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

export function overrideCertKeyPair<T>(certKey: { key: Buffer; cert: Buffer; }, code: () => T): T {
    let prevOverride = certKeyPairOverride;
    certKeyPairOverride = certKey;
    try {
        return code();
    } finally {
        certKeyPairOverride = prevOverride;
    }
}

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
        throw new Error(`Missing nodeId. If it is from the browser, this likely means your websocket and HTTP request are using different domains (so the cookies are lost). If it is from NodeJs peer certificate must use an RSA key or EC key (which should have a .modulus property)`);
    }
    return nodeId;
});

export function getNodeIdFromCert(cert: { modulus: Buffer }) {
    // Apparently some implementations strip preceding zeros, which makes sense, as it is a modulus so
    //  preceding zeros aren't needed.
    let startIndex = 0;
    while (startIndex < cert.modulus.length && cert.modulus[startIndex] === 0) {
        startIndex++;
    }
    return sha256Hash(cert.modulus.slice(startIndex));
}
const ed25519OID = "302a300506032b6570032100";
export function getNodeIdRaw(socket: tls.TLSSocket) {
    let peerCert = socket.getPeerCertificate(true);
    if (!peerCert?.raw) return undefined;

    if (!peerCert.modulus) {
        let cert = new crypto.X509Certificate(peerCert.raw);
        // I'm not too sure about the type and format, but... I'm sure some permutation
        //  of these parameters will work.
        debugbreak(1);
        debugger;
        let publicKey = cert.publicKey.export({ type: "spki", format: "pem" }).toString("hex");
        if (publicKey.startsWith(ed25519OID)) {
            publicKey = publicKey.slice(ed25519OID.length);
        }
        return publicKey;
    }
    return getNodeIdFromCert({ modulus: Buffer.from(peerCert.modulus, "hex") });
}

let subprotocol: string | undefined;
export function overrideWebsocketSubProtocol<T>(_subprotocol: string, code: () => T) {
    let prev = subprotocol;
    subprotocol = _subprotocol;
    try {
        return code();
    } finally {
        subprotocol = prev;
    }
}

/** NOTE: We create a factory, which embeds the key/cert information. Otherwise retries might use
 *      a different key/cert context.
 */
export function createWebsocketFactory(): (address: string, port: number) => SenderInterface {

    if (!isNode()) {
        // NOTE: We assume an HTTP request has already been made, which will setup a nodeId cookie
        //  (And as this point we can't even use peer certificates if we wanted to, as this must be done
        //      directly in the browser)
        let subprotocolOverride = subprotocol;
        return (address: string, port: number) => {
            console.log(`Connecting to ${address}:${port}`);
            let subprotocols = subprotocolOverride ? [subprotocolOverride] : undefined;
            return new WebSocket(`wss://${address}:${port}`, subprotocols);
        };
    } else {
        let { key, cert } = getCertKeyPair();
        let rejectUnauthorized = SocketFunction.rejectUnauthorized;
        return (address: string, port: number) => {
            console.log(`Connecting to ${address}:${port}`);
            let webSocket = new ws.WebSocket(`wss://${address}:${port}`, {
                cert,
                key,
                rejectUnauthorized,
                ca: tls.rootCertificates.concat(SocketFunction.additionalTrustedRootCAs),
                protocol: subprotocol,
            });
            let result = Object.assign(webSocket, { socket: undefined as tls.TLSSocket | undefined });
            webSocket.once("upgrade", e => {
                result.socket = e.socket as tls.TLSSocket;
            });
            return result;
        };
    }
}