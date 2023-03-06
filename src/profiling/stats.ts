export interface StatsValue {
    count: number;
    sum: number;
    sumSquares: number;

    // All logs use base 10
    //  This supports values from 0.1ns to 1 week
    logn7Value: number; logn7Count: number; logn6Value: number; logn6Count: number; logn5Value: number; logn5Count: number; logn4Value: number; logn4Count: number; logn3Value: number; logn3Count: number; logn2Value: number; logn2Count: number; logn1Value: number; logn1Count: number; log0Value: number; log0VCount: number; log1Value: number; log1VCount: number; log2Value: number; log2VCount: number; log3Value: number; log3VCount: number; log4Value: number; log4VCount: number; log5Value: number; log5VCount: number; log6Value: number; log6VCount: number; log7Value: number; log7VCount: number; log8Value: number; log8VCount: number; log9Value: number; log9VCount: number;
}

export function createStatsValue(): StatsValue {
    return {
        count: 0,
        sum: 0,
        sumSquares: 0,
        logn7Value: 0, logn7Count: 0, logn6Value: 0, logn6Count: 0, logn5Value: 0, logn5Count: 0, logn4Value: 0, logn4Count: 0, logn3Value: 0, logn3Count: 0, logn2Value: 0, logn2Count: 0, logn1Value: 0, logn1Count: 0, log0Value: 0, log0VCount: 0, log1Value: 0, log1VCount: 0, log2Value: 0, log2VCount: 0, log3Value: 0, log3VCount: 0, log4Value: 0, log4VCount: 0, log5Value: 0, log5VCount: 0, log6Value: 0, log6VCount: 0, log7Value: 0, log7VCount: 0, log8Value: 0, log8VCount: 0, log9Value: 0, log9VCount: 0,
    };
}

// TIMING: Between 5.6ns and 8ns, depending on the size of the value (smaller values are faster to add)
//  - A C++ implementation takes about 3.5ns, so... this is pretty fast!
export function addToStatsValue(stats: StatsValue, value: number) {
    stats.count++;
    stats.sum += value;
    stats.sumSquares += value * value;
    if (value < 0.000001) {
        stats.logn7Value += value;
        stats.logn7Count++;
    } else if (value < 0.00001) {
        stats.logn6Value += value;
        stats.logn6Count++;
    } else if (value < 0.0001) {
        stats.logn5Value += value;
        stats.logn5Count++;
    } else if (value < 0.001) {
        stats.logn4Value += value;
        stats.logn4Count++;
    } else if (value < 0.01) {
        stats.logn3Value += value;
        stats.logn3Count++;
    } else if (value < 0.1) {
        stats.logn2Value += value;
        stats.logn2Count++;
    } else if (value < 1) {
        stats.logn1Value += value;
        stats.logn1Count++;
    } else if (value < 10) {
        stats.log0Value += value;
        stats.log0VCount++;
    } else if (value < 100) {
        stats.log1Value += value;
        stats.log1VCount++;
    } else if (value < 1000) {
        stats.log2Value += value;
        stats.log2VCount++;
    } else if (value < 10000) {
        stats.log3Value += value;
        stats.log3VCount++;
    } else if (value < 100000) {
        stats.log4Value += value;
        stats.log4VCount++;
    } else if (value < 1000000) {
        stats.log5Value += value;
        stats.log5VCount++;
    } else if (value < 10000000) {
        stats.log6Value += value;
        stats.log6VCount++;
    } else if (value < 100000000) {
        stats.log7Value += value;
        stats.log7VCount++;
    } else if (value < 1000000000) {
        stats.log8Value += value;
        stats.log8VCount++;
    } else {
        stats.log9Value += value;
        stats.log9VCount++;
    }
}

export function addToStats(stats: StatsValue, other: StatsValue) {
    stats.count += other.count;
    stats.sum += other.sum;
    stats.sumSquares += other.sumSquares;
    stats.logn7Value += other.logn7Value;
    stats.logn7Count += other.logn7Count;
    stats.logn6Value += other.logn6Value;
    stats.logn6Count += other.logn6Count;
    stats.logn5Value += other.logn5Value;
    stats.logn5Count += other.logn5Count;
    stats.logn4Value += other.logn4Value;
    stats.logn4Count += other.logn4Count;
    stats.logn3Value += other.logn3Value;
    stats.logn3Count += other.logn3Count;
    stats.logn2Value += other.logn2Value;
    stats.logn2Count += other.logn2Count;
    stats.logn1Value += other.logn1Value;
    stats.logn1Count += other.logn1Count;
    stats.log0Value += other.log0Value;
    stats.log0VCount += other.log0VCount;
    stats.log1Value += other.log1Value;
    stats.log1VCount += other.log1VCount;
    stats.log2Value += other.log2Value;
    stats.log2VCount += other.log2VCount;
    stats.log3Value += other.log3Value;
    stats.log3VCount += other.log3VCount;
    stats.log4Value += other.log4Value;
    stats.log4VCount += other.log4VCount;
    stats.log5Value += other.log5Value;
    stats.log5VCount += other.log5VCount;
    stats.log6Value += other.log6Value;
    stats.log6VCount += other.log6VCount;
    stats.log7Value += other.log7Value;
    stats.log7VCount += other.log7VCount;
    stats.log8Value += other.log8Value;
    stats.log8VCount += other.log8VCount;
    stats.log9Value += other.log9Value;
    stats.log9VCount += other.log9VCount;
}

interface StatsBucket {
    sum: number;
    count: number;
}
// Ordered from lowest average to highest average
function getStatsBuckets(stats: StatsValue): StatsBucket[] {
    return [
        { sum: stats.logn7Value, count: stats.logn7Count },
        { sum: stats.logn6Value, count: stats.logn6Count },
        { sum: stats.logn5Value, count: stats.logn5Count },
        { sum: stats.logn4Value, count: stats.logn4Count },
        { sum: stats.logn3Value, count: stats.logn3Count },
        { sum: stats.logn2Value, count: stats.logn2Count },
        { sum: stats.logn1Value, count: stats.logn1Count },
        { sum: stats.log0Value, count: stats.log0VCount },
        { sum: stats.log1Value, count: stats.log1VCount },
        { sum: stats.log2Value, count: stats.log2VCount },
        { sum: stats.log3Value, count: stats.log3VCount },
        { sum: stats.log4Value, count: stats.log4VCount },
        { sum: stats.log5Value, count: stats.log5VCount },
        { sum: stats.log6Value, count: stats.log6VCount },
        { sum: stats.log7Value, count: stats.log7VCount },
        { sum: stats.log8Value, count: stats.log8VCount },
        { sum: stats.log9Value, count: stats.log9VCount },
    ];
}

export interface StatsTop {
    // NOTE: countFraction <= valueFraction, because we take the largest values
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
export function getStatsTop(stats: StatsValue): StatsTop {
    if (stats.sum === 0) {
        return { countFraction: 1, valueFraction: 1, count: 0, value: 0, topHeavy: false, };
    }

    const minFraction = 0.2;

    let totalSum = stats.sum;
    let totalCount = stats.count;
    let totalMean = totalSum / totalCount;

    // Find the sum above the average (with a minimum of minFraction, as sometimes there isn't really anything above the average)
    let buckets = getStatsBuckets(stats);
    buckets.reverse();

    let curSum = 0;
    let curCount = 0;
    for (let entry of buckets) {
        let mean = entry.sum / entry.count;
        if (curSum > totalSum * minFraction && mean < totalMean) break;

        curSum += entry.sum;
        curCount += entry.count;
    }

    let countFraction = curCount / totalCount;
    let valueFraction = curSum / totalSum;

    return {
        countFraction,
        valueFraction,
        count: curCount,
        value: curSum,
        // If more than 50% is above the average, it's top heavy
        topHeavy: valueFraction / countFraction > 2 && valueFraction > 0.4,
    };
}





function benchmarkAddToStats() {
    let stats = createStatsValue();
    let start = Date.now();
    const count = 1000000;
    for (let i = 0; i < count; i++) {
        addToStatsValue(stats, 10000000000);
    }
    let end = Date.now();
    let time = end - start;
    let timePer = (time) / count * 1000 * 1000;
    console.log(`Time per: ${timePer}ns, in ${time}ms`);
}
//benchmarkAddToStats();