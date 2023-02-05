import * as tls from "tls";

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
    return tls.rootCertificates.concat(Array.from(trustedCerts));
}

export function watchTrustedCertificates(callback: (certs: string[]) => void) {
    watchCallbacks.add(callback);
    callback(getTrustedCertificates());
    return () => watchCallbacks.delete(callback);
}