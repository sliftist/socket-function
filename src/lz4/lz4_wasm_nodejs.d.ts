/* tslint:disable */
/* eslint-disable */

/**
 * Streaming LZ4 compressor (frame format with linked blocks).
 * Concatenate all output chunks to form a complete LZ4 frame.
 */
export class Lz4StreamCompressor {
    free(): void;
    [Symbol.dispose](): void;
    compress(input: Uint8Array): Uint8Array;
    constructor();
}

/**
 * One-shot block compression with size prepended.
 */
export function compress(input: Uint8Array): Uint8Array;

/**
 * One-shot block decompression with size prepended.
 */
export function decompress(input: Uint8Array): Uint8Array;

/**
 * Decompress an LZ4 stream (frame format).
 * Auto-injects end marker if missing. On error, returns partial data and sets a warning.
 */
export function decompress_stream(input: Uint8Array): Uint8Array;

/**
 * Get and clear the last warning from decompression.
 */
export function get_last_warning(): string | undefined;
