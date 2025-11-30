export declare function formatTime(milliseconds: number | undefined, maxAbsoluteValue?: number): string;
export declare function getTargetDecimals(maxAbsoluteValue: number, targetDigits: number): number;
/** Adds decimal digits to reach digits. If the number is simply too large, it won't remove
 *      digits, there will instead just be no decimal point.
 */
export declare function formatMaxDecimals(num: number, targetDigits: number, maxAbsoluteValue?: number, exactDecimals?: number): string;
/** Actually formats any number, including decimals, by using K, M and B suffixes to get smaller values
 *      TODO: Support uK, uM and uB suffixes for very small numbers?
 *      <= 6 characters (<= 5 if positive)
 */
export declare function formatNumber(count: number | undefined, maxAbsoluteValue?: number, noDecimal?: boolean, specialCurrency?: boolean): string;
export declare function formatBinaryNumber(count: number | undefined, maxAbsoluteValue?: number, noDecimal?: boolean, specialCurrency?: boolean): string;
/** YYYY/MM/DD HH:MM:SS PM/AM */
export declare function formatDateTime(time: number): string;
export declare function formatDateTimeDetailed(time: number): string;
export declare function formatFileTimestampLocal(time: number): string;
/** 2024 January 1, Monday, 12:53:02pm */
export declare function formatNiceDateTime(time: number): string;
/** 2024 January 1, Monday, 12:53:02pm (4 months ago)  */
export declare function formatVeryNiceDateTime(time: number): string;
/** YYYY/MM/DD */
export declare function formatDate(time: number): string;
/** <= 6 characters (<= 5 if positive) */
export declare function formatPercent(value: number): string;
