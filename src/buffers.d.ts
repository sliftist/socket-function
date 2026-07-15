/// <reference types="node" />
export type ArrayBufferViewTypes = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | BigUint64Array | BigInt64Array | Float64Array | Float32Array | Uint8ClampedArray;
export type BufferType = ArrayBuffer | SharedArrayBuffer | ArrayBufferViewTypes;
export declare function cloneBuffer(data: Buffer): Buffer;
export declare function asBuffer(data: BufferType): Buffer;
export declare function asFloat64(data: Buffer): Float64Array;
export declare function asFloat32(data: Buffer): Float32Array;
export declare function asUint32(data: Buffer): Uint32Array;
export declare function asInt32(data: Buffer): Int32Array;
export declare function asFloat64MaybeCopy(data: Buffer): Float64Array;
