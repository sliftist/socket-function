import { canHaveChildren } from "./types";

export type ArrayBufferViewTypes = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | BigUint64Array | BigInt64Array | Float64Array | Float32Array | Uint8ClampedArray;
export type BufferType = ArrayBuffer | SharedArrayBuffer | ArrayBufferViewTypes;

export function cloneBuffer(data: Buffer): Buffer {
    let newBuffer = Buffer.alloc(data.length);
    data.copy(newBuffer);
    return newBuffer;
}


export function asBuffer(data: BufferType): Buffer {
    if (!data) return data;
    if (data instanceof Buffer) return data;
    if (!canHaveChildren(data)) return data as any;
    if (!("buffer" in data) || !("byteOffset" in data) || !("byteLength" in data)) {
        return Buffer.from(data);
    }
    let result = Buffer.from((data as any).buffer, (data as any).byteOffset, (data as any).byteLength);
    return result;
}
export function asFloat64(data: Buffer): Float64Array {
    if (data.length % 8 !== 0) {
        throw new Error(`Data is not 8 count aligned, received length of ${data.length}`);
    }
    if (data.byteOffset % 8 !== 0) {
        throw new Error(`Data is not 8 byte aligned, received offset of ${data.byteOffset}`);
    }
    return new Float64Array(data.buffer, data.byteOffset, Math.floor(data.length / 8));
}
export function asFloat32(data: Buffer): Float32Array {
    if (data.length % 4 !== 0) {
        throw new Error(`Data is not 4 byte aligned, received length of ${data.length}`);
    }
    if (data.byteOffset % 4 !== 0) {
        throw new Error(`Data is not 4 byte aligned, received offset of ${data.byteOffset}`);
    }
    return new Float32Array(data.buffer, data.byteOffset, Math.floor(data.length / 4));
}
export function asUint32(data: Buffer): Uint32Array {
    if (data.length % 4 !== 0) {
        throw new Error(`Data is not 4 byte aligned, received length of ${data.length}`);
    }
    if (data.byteOffset % 4 !== 0) {
        throw new Error(`Data is not 4 byte aligned, received offset of ${data.byteOffset}`);
    }
    return new Uint32Array(data.buffer, data.byteOffset, Math.floor(data.length / 4));
}
export function asInt32(data: Buffer): Int32Array {
    if (data.length % 4 !== 0) {
        throw new Error(`Data is not 4 byte aligned, received length of ${data.length}`);
    }
    if (data.byteOffset % 4 !== 0) {
        throw new Error(`Data is not 4 byte aligned, received offset of ${data.byteOffset}`);
    }
    return new Int32Array(data.buffer, data.byteOffset, Math.floor(data.length / 4));
}


export function asFloat64MaybeCopy(data: Buffer) {
    if (data.length % 8 !== 0) {
        throw new Error(`Data is not 8 count aligned, received length of ${data.length}`);
    }
    if (data.byteOffset % 8 !== 0) {
        return asFloat64(cloneBuffer(data));
    }
    return new Float64Array(data.buffer, data.byteOffset, Math.floor(data.length / 8));
}
