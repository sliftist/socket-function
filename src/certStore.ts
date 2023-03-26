import * as tls from "tls";
import { isNode, sha256Hash } from "./misc";

let trustedCerts = new Set<string>();
let watchCallbacks = new Set<(certs: string[]) => void>();

/** Must be populated before the server starts */
export function trustCertificate(cert: string | Buffer) {
    cert = cert.toString();
    if (trustedCerts.has(cert)) return;
    trustedCerts.add(cert);
    let certs = getTrustedCertificates();
    for (let callback of watchCallbacks) {
        callback(certs);
    }
}
export function getTrustedCertificates(): string[] {
    let certs: string[] = [];
    if (isNode()) {
        certs.push(...tls.rootCertificates);
    }
    certs.push(...Array.from(trustedCerts));
    return certs;
}

export function watchTrustedCertificates(callback: (certs: string[]) => void) {
    watchCallbacks.add(callback);
    callback(getTrustedCertificates());
    return () => watchCallbacks.delete(callback);
}