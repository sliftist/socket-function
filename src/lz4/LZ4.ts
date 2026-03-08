// NOTE: Even if we wanted to use the production version, we couldn't because it's not compatible with the client-side code, because they decided to do a file read to load in their WebAssembly. 
import lz4_stream from "./lz4_wasm_nodejs";
import { measureFnc } from "../profiling/measure";
export class LZ4 {
    @measureFnc
    static compress(data: Buffer): Buffer {
        return this.compressUntracked(data);
    }
    static compressUntracked(data: Buffer): Buffer {
        try {
            return Buffer.from(lz4_stream.compress(data));
        } catch (e) {
            // Rethrow non errors as properly wrapped errors
            if (!(e && e instanceof Error)) {
                throw new Error(`Error compressing LZ4: ${e}`);
            }
            throw e;
        }
    }
    @measureFnc
    static decompress(data: Buffer): Buffer {
        try {
            return Buffer.from(lz4_stream.decompress(data));
        } catch (e) {
            // Rethrow non errors as properly wrapped errors
            if (!(e && e instanceof Error)) {
                throw new Error(`Error decompressing LZ4: ${e}`);
            }
            throw e;
        }
    }
}