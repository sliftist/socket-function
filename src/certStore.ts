import * as os from "os";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as child_process from "child_process";
import * as tls from "tls";
import { SocketFunction } from "../SocketFunction";
import { isNode, isNodeTrue, sha256Hash } from "./misc";
import { lazy } from "./caching";

let trustedCerts = new Set<string>();
let loadedTrustedCerts = false;
let watchCallbacks = new Set<(certs: string[]) => void>();

let storePath = isNodeTrue() && process.argv[1].replaceAll("\\", "/").split("/").slice(0, -1).join("/") + "/certstore/";
if (isNode()) {
    if (!fsSync.existsSync(storePath)) {
        fsSync.mkdirSync(storePath);
    }
}

/** Must be populated before the server starts */
export async function trustUserCertificate(cert: string) {
    if (trustedCerts.has(cert)) return;
    trustedCerts.add(cert);
    await fs.writeFile(storePath + sha256Hash(Buffer.from(cert)) + ".cer", cert);
    let certs = getTrustedUserCertificates();
    for (let callback of watchCallbacks) {
        callback(certs);
    }
}
export const loadTrustedUserCertificates = lazy(async () => {
    let files = await fs.readdir(storePath);
    for (let file of files) {
        let cert = await fs.readFile(storePath + file, "utf8");
        trustedCerts.add(cert);
    }
    loadedTrustedCerts = true;
});
export function getTrustedUserCertificates(): string[] {
    if (!loadedTrustedCerts) {
        throw new Error("Must call loadTrustedUserCertificates (and await it) before calling getTrustedUserCertificates");
    }
    return Array.from(trustedCerts);
}

export function watchUserCertificates(callback: (certs: string[]) => void) {
    watchCallbacks.add(callback);
    callback(getTrustedUserCertificates());
    return () => watchCallbacks.delete(callback);
}