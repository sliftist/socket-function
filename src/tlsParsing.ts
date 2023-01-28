export function parseTLSHello(buffer: Buffer): {
    extensions: {
        type: number;
        data: Buffer;
    }[];
} {
    let output: {
        extensions: {
            type: number;
            data: Buffer;
        }[];
    } = {
        extensions: []
    };

    try {
        let pos = 0;

        function readShort() {
            let high = buffer[pos++];
            let low = buffer[pos++];
            return high * 256 + low;
        }

        let type = buffer[pos++];
        let version = readShort();

        var contentLength = readShort();

        let clientMessageType = buffer[pos++];
        // High length byte (how would this be used if contentLength is only 2 bytes?)
        pos++;
        let clientMessageLength = readShort();

        // Client version
        let clientVersion = readShort();

        // Client random
        pos += 32;

        // Session id
        let sessionIdLength = buffer[pos++];
        pos += sessionIdLength;


        let cipherSuiteLength = readShort();
        pos += cipherSuiteLength;

        let compressionLength = buffer[pos++];
        pos += compressionLength;

        let extensionsLength = readShort();
        let extensionsEnd = pos + extensionsLength;
        while (pos < extensionsEnd) {
            let extensionType = readShort();
            let length = readShort();

            output.extensions.push({
                type: extensionType, data: viewSliceBuffer(buffer, pos, length)
            });

            pos += length;
        }
    } catch { }

    return output;
}

export const SNIType = 0x0;
export function parseSNIExtension(data: Buffer): string[] {
    let pos = 0;
    function readShort() {
        let high = data[pos++];
        let low = data[pos++];
        return high * 256 + low;
    }

    let snis: string[] = [];

    try {
        while (pos < data.length) {
            let len = readShort();
            let end = pos + len;
            let type = data[pos++];
            let len2 = readShort();
            snis.push(viewSliceBuffer(data, pos, len2).toString());
            pos = end;
        }
    } catch { }

    return snis;
}

function viewSliceBuffer(data: Buffer, index: number, count?: number) {
    count = count ?? (data.length - index);
    return Buffer.from(data.buffer, data.byteOffset + index, count);
}