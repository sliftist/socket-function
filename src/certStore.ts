import * as tls from "tls";
import { sha256Hash } from "./misc";

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
    //console.log(`trustedCerts = ${Array.from(trustedCerts).map(x => sha256Hash(x).slice(0, 10))}`);
    return tls.rootCertificates.concat(Array.from(trustedCerts));
}

export function watchTrustedCertificates(callback: (certs: string[]) => void) {
    watchCallbacks.add(callback);
    callback(getTrustedCertificates());
    return () => watchCallbacks.delete(callback);
}