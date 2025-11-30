export interface StatsValue {
    count: number;
    sum: number;
    sumSquares: number;
    logn7Value: number;
    logn7Count: number;
    logn6Value: number;
    logn6Count: number;
    logn5Value: number;
    logn5Count: number;
    logn4Value: number;
    logn4Count: number;
    logn3Value: number;
    logn3Count: number;
    logn2Value: number;
    logn2Count: number;
    logn1Value: number;
    logn1Count: number;
    log0Value: number;
    log0VCount: number;
    log1Value: number;
    log1VCount: number;
    log2Value: number;
    log2VCount: number;
    log3Value: number;
    log3VCount: number;
    log4Value: number;
    log4VCount: number;
    log5Value: number;
    log5VCount: number;
    log6Value: number;
    log6VCount: number;
    log7Value: number;
    log7VCount: number;
    log8Value: number;
    log8VCount: number;
    log9Value: number;
    log9VCount: number;
}
export declare function createStatsValue(): StatsValue;
export declare function addToStatsValue(stats: StatsValue, value: number): void;
export declare function addToStats(stats: StatsValue, other: StatsValue): void;
export interface StatsTop {
    countFraction: number;
    valueFraction: number;
    count: number;
    value: number;
    topHeavy: boolean;
}
/** Identifies cases where the value is concentrated in few instances. This indicates most of the value (time)
 *      is not spent on the common case, but on an outlier. Which isn't a problem, it just means that the measurements
 *      should be more precise, to pull that heavy case out.
 */
export declare function getStatsTop(stats: StatsValue): StatsTop;
