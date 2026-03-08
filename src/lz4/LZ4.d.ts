/// <reference types="node" />
/// <reference types="node" />
export declare class LZ4 {
    static compress(data: Buffer): Buffer;
    static compressUntracked(data: Buffer): Buffer;
    static decompress(data: Buffer): Buffer;
}
