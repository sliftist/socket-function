
/** Subtracts the smallest possible value from a number (a double). This makes it possible to convert an exclusive range end
 *      to an inclusive range end, which is sometimes required (as in, < x is the same as <= minusEpsilon(x)).
 */
export function minusEpsilon(value: number) {
    let high = getHighUint32(value);
    let low = getLowUint32(value);

    if (low === 0) {
        low = 2 ** 32 - 1;
        high--;
    } else {
        low--;
    }

    return setLowHighUint32(low, high);
}
const maxUint32 = 2 ** 32 - 1;
export function addEpsilons(value: number, count: number) {
    let high = getHighUint32(value);
    let low = getLowUint32(value);

    low += count;
    if (low < 0) {
        low += maxUint32;
        high++;
    } else if (low > maxUint32) {
        low -= maxUint32;
        high--;
    }

    return setLowHighUint32(low, high);
}

let conversionBuffer = new Float64Array(1);
let conversionUint8Buffer = new Uint8Array(conversionBuffer.buffer);
let conversionUint32Buffer = new Uint32Array(conversionBuffer.buffer);
export function getHighUint32(num: number): number {
    conversionBuffer[0] = num;
    return conversionUint32Buffer[1];
}
export function getLowUint32(num: number): number {
    conversionBuffer[0] = num;
    return conversionUint32Buffer[0];
}

/** IMPORTANT! Beware of comparisons with 64 bit numbers. getFloat64_fromBytes(4294136438, 168) !== getFloat64_fromBytes(4294136438, 168).
 *      USE is64BitEqual instead, OR, ensure the 2 highest bits are always 0.
 */
export function setLowHighUint32(low: number, high: number): number {
    conversionUint32Buffer[0] = low;
    conversionUint32Buffer[1] = high;
    return conversionBuffer[0];
}

/** Adds protection against NaN values, changing the result if it would be NaN. This is because NaN values will compare to be not equal even if they are equal in certain cases, and in other cases, they'll always be equal, even if their bits are not equal.
    - This means this is not a reversible operation. However, in a lot of cases, that doesn't matter. 
*/
export function setLowHighUint32Safe(low: number, high: number): number {
    conversionUint32Buffer[0] = low;
    // Prevent NaN by not setting all the exponent bits to 1
    conversionUint32Buffer[1] = high & 0xBFFFFFFF;
    return conversionBuffer[0];
}

// NOTE: Not reversible, see setLowHighUint32Safe
export function xor64BitsSafe(a: number, b: number): number {
    let high = getHighUint32(a);
    let low = getLowUint32(a);
    let high2 = getHighUint32(b);
    let low2 = getLowUint32(b);
    return setLowHighUint32Safe(low ^ low2, high ^ high2);
}

// Gets bits that can be stored in a number. Specifically, the first 62 bits,
//  as 64 bits will not compare correctly when treated as a double.
export function getShortNumber(buffer: Buffer): number {
    let high = buffer.readUInt32BE(0) & 0x3FFFFFFF;
    let low = buffer.readUInt32BE(4);
    return setLowHighUint32(low, high);
}
/* Returns a number between 0 and 2**48 */
export function getBufferInt(buffer: Buffer): number {
    let num = 0;
    for (let i = 0; i < Math.min(buffer.length, 6); i++) {
        num = num * 256 + buffer[i];
    }
    return num;
}
const intMax = 2 ** 48;
/** Returns a number between 0 (inclusive) and 1 (exclusive) */
export function getBufferFraction(buffer: Buffer): number {
    let int = getBufferInt(buffer);
    return int / intMax;
}

/*
export function numberToBase64(num: number): string {
    conversionBuffer[0] = num;
    return Buffer.from(conversionBuffer.buffer).toString("base64");
}
export function numberFromBase64(base64: string) {
    return new Float64Array(Buffer.from(base64, "base64"))[0];
}
*/


let prevTime = 0;
export function getTimeUnique() {
    let time = Date.now();
    if (time <= prevTime) {
        time = addEpsilons(prevTime, 1);
    }
    prevTime = time;
    return time;
}