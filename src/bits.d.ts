/// <reference types="node" />
/** Subtracts the smallest possible value from a number (a double). This makes it possible to convert an exclusive range end
 *      to an inclusive range end, which is sometimes required (as in, < x is the same as <= minusEpsilon(x)).
 */
export declare function minusEpsilon(value: number): number;
export declare function addEpsilons(value: number, count: number): number;
export declare function getHighUint32(num: number): number;
export declare function getLowUint32(num: number): number;
/** IMPORTANT! Beware of comparisons with 64 bit numbers. getFloat64_fromBytes(4294136438, 168) !== getFloat64_fromBytes(4294136438, 168).
 *      USE is64BitEqual instead, OR, ensure the 2 highest bits are always 0.
 */
export declare function setLowHighUint32(low: number, high: number): number;
/** Adds protection against NaN values, changing the result if it would be NaN. This is because NaN values will compare to be not equal even if they are equal in certain cases, and in other cases, they'll always be equal, even if their bits are not equal.
    - This means this is not a reversible operation. However, in a lot of cases, that doesn't matter.
*/
export declare function setLowHighUint32Safe(low: number, high: number): number;
export declare function xor64BitsSafe(a: number, b: number): number;
export declare function getShortNumber(buffer: Buffer): number;
export declare function getBufferInt(buffer: Buffer): number;
/** Returns a number between 0 (inclusive) and 1 (exclusive) */
export declare function getBufferFraction(buffer: Buffer): number;
export declare function getTimeUnique(): number;
