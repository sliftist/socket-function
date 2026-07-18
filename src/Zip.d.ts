/// <reference types="node" />
/// <reference types="node" />
import { MaybePromise } from "./types";
export declare class Zip {
    static gzip(buffer: Buffer, level?: number): Promise<Buffer>;
    static gzipSync(buffer: Buffer, level?: number): Buffer;
    static gunzip(buffer: Buffer): MaybePromise<Buffer>;
    static gunzipAsyncBase(buffer: Buffer): Promise<Buffer>;
    static gunzipSync(buffer: Buffer): Buffer;
    static gunzipBatch(buffers: Buffer[]): Promise<Buffer[]>;
    static gunzipUntracked(buffer: Buffer): MaybePromise<Buffer>;
    private static gunzipUntrackedSync;
}
