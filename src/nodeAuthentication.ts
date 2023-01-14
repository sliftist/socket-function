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
import { getTrustedUserCertificates } from "./certStore";
import { getClientNodeId, getNodeId, getNodeIdLocation } from "./nodeCache";

export type CertInfo = { raw: Buffer | string; issuerCertificate: { raw: Buffer | string } };

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
    if (!isNode()) {
        throw new Error(`Cannot override cert/key pair in browser`);
    }
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

export function getNodeIdFromCert(certRaw: { raw: Buffer | string } | undefined, callbackPort: number | undefined) {
    if (!certRaw?.raw) return undefined;
    let cert = new crypto.X509Certificate(certRaw.raw);
    if (!callbackPort) {
        return getClientNodeId(cert.subject);
    }
    let subject = cert.subject;
    if (subject.startsWith("CN=")) {
        subject = subject.slice("CN=".length);
    }
    return getNodeId(subject, callbackPort);
}

/** NOTE: We create a factory, which embeds the key/cert information. Otherwise retries might use
 *      a different key/cert context.
 */
export function createWebsocketFactory(): (nodeId: string) => SenderInterface {

    if (!isNode()) {
        return (nodeId: string) => {
            let location = getNodeIdLocation(nodeId);
            if (!location) throw new Error(`Cannot connect to ${nodeId}, no address known`);
            let { address, port } = location;

            console.log(`Connecting to ${address}:${port}`);
            return new WebSocket(`wss://${address}:${port}`);
        };
    } else {
        let { key, cert } = getCertKeyPair();
        let rejectUnauthorized = SocketFunction.rejectUnauthorized;
        return (nodeId: string) => {
            let location = getNodeIdLocation(nodeId);
            if (!location) throw new Error(`Cannot connect to ${nodeId}, no address known`);
            let { address, port } = location;

            console.log(`Connecting to ${address}:${port}`);
            let webSocket = new ws.WebSocket(`wss://${address}:${port}`, {
                cert,
                key,
                rejectUnauthorized,
                ca: tls.rootCertificates.concat(getTrustedUserCertificates()),
            });
            let result = Object.assign(webSocket, { socket: undefined as tls.TLSSocket | undefined });
            webSocket.once("upgrade", e => {
                result.socket = e.socket as tls.TLSSocket;
            });
            return result;
        };
    }
}

