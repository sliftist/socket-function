/// <reference types="node" />
/// <reference types="node" />
export declare function parseTLSHello(buffer: Buffer): {
    extensions: {
        type: number;
        data: Buffer;
    }[];
    missingBytes: number;
};
export declare const SNIType = 0;
export declare function parseSNIExtension(data: Buffer): string[];
