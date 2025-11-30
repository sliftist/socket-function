/// <reference types="node" />
/// <reference types="node" />
/** Must be populated before the server starts */
export declare function trustCertificate(cert: string | Buffer): void;
export declare function getTrustedCertificates(): string[];
export declare function watchTrustedCertificates(callback: (certs: string[]) => void): () => boolean;
