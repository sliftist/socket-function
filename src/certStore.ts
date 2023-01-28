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

/** Must be populated before the server starts */
export async function trustUserCertificate(cert: string) {
    if (trustedCerts.has(cert)) return;
    trustedCerts.add(cert);
    let certs = getTrustedUserCertificates();
    for (let callback of watchCallbacks) {
        callback(certs);
    }
}
export function getTrustedUserCertificates(): string[] {
    return Array.from(trustedCerts);
}

export function watchUserCertificates(callback: (certs: string[]) => void) {
    watchCallbacks.add(callback);
    callback(getTrustedUserCertificates());
    return () => watchCallbacks.delete(callback);
}