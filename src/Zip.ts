import { isNode } from "./misc";
import { measureFnc } from "./profiling/measure";
import zlib from "zlib";
import * as pako from "pako";

import { setFlag } from "../require/compileFlags";
import { MaybePromise } from "./types";
setFlag(require, "pako", "allowclient", true);

const SYNC_THRESHOLD_BYTES = 100_000_000;
const ZIP_SYNC_THRESHOLD_BYTES = 10_000_000;

// IMPORTANT! If this ever profiles as being slow, we should switch to a wasm implementation of L4Z. For our highly repetitive data, it's almost as efficient in terms of size, and it should be significantly more efficient in terms of time.
export class Zip {
    @measureFnc
    public static async gzip(buffer: Buffer, level?: number): Promise<Buffer> {
        if (buffer.length < ZIP_SYNC_THRESHOLD_BYTES) {
            return this.gzipSync(buffer, level);
        }
        if (isNode()) {
            return new Promise((resolve, reject) => {
                zlib.gzip(buffer, { level }, (err: any, result: Buffer) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            });
        } else {
            // @ts-ignore
            return await doStream(new CompressionStream("gzip"), buffer);
        }
    }
    @measureFnc
    public static gzipSync(buffer: Buffer, level?: number): Buffer {
        if (isNode() && buffer.length < ZIP_SYNC_THRESHOLD_BYTES) {
            return Buffer.from(zlib.gzipSync(buffer, { level }));
        }
        return Buffer.from(pako.gzip(buffer));
    }

    @measureFnc
    public static gunzip(buffer: Buffer): MaybePromise<Buffer> {
        return this.gunzipUntracked(buffer);
    }
    @measureFnc
    public static async gunzipAsyncBase(buffer: Buffer): Promise<Buffer> {
        return this.gunzipUntracked(buffer);
    }

    @measureFnc
    public static gunzipSync(buffer: Buffer): Buffer {
        return this.gunzipUntrackedSync(buffer);
    }

    @measureFnc
    public static async gunzipBatch(buffers: Buffer[]): Promise<Buffer[]> {
        let time = Date.now();
        buffers = await Promise.all(buffers.map(x => {
            return this.gunzipUntracked(x);
        }));
        time = Date.now() - time;
        // let totalSize = buffers.reduce((acc, buffer) => acc + buffer.length, 0);
        //console.log(`Gunzip ${formatNumber(totalSize)}B at ${formatNumber(totalSize / time * 1000)}B/s`);
        return buffers;
    }



    public static gunzipUntracked(buffer: Buffer): MaybePromise<Buffer> {
        // Switch to the synchronous version if the buffer is small. This is a lot faster in Node.js and clientside.
        //  - On tests of random small amounts of data, this seems to be up to 7X faster (on node). However, on non-random data, on the actual data we're using, it seems to be almost 50 times faster. So... definitely worth it...
        if (buffer.length < SYNC_THRESHOLD_BYTES) {
            let time = Date.now();
            let result = Zip.gunzipUntrackedSync(buffer);
            let duration = Date.now() - time;
            if (duration > 50) {
                // Wait, so we don't lock up the main thread. And if we already wait it 50ms, then waiting for one frame is marginal, even client-side. 
                return ((async () => {
                    await new Promise(resolve => setTimeout(resolve, 0));
                    return result;
                }))();
            }
            return result;
        }
        if (isNode()) {
            return doStream(new DecompressionStream("gzip"), buffer);
        } else {
            return Zip.gunzipUntrackedSync(buffer);
        }
    }

    private static gunzipUntrackedSync(buffer: Buffer): Buffer {
        if (isNode() && buffer.length < ZIP_SYNC_THRESHOLD_BYTES) {
            return Buffer.from(zlib.gunzipSync(buffer));
        }
        return Buffer.from(pako.ungzip(buffer));
    }
}

async function doStream(stream: GenericTransformStream, buffer: Buffer): Promise<Buffer> {
    let reader = stream.readable.getReader();
    let writer = stream.writable.getWriter();
    let writePromise = writer.write(buffer);
    let closePromise = writer.close();

    let outputBuffers: Buffer[] = [];
    while (true) {
        let { value, done } = await reader.read();
        if (done) {
            await writePromise;
            await closePromise;
            return Buffer.concat(outputBuffers);
        }
        outputBuffers.push(Buffer.from(value));
    }

}