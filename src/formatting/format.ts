export function formatTime(milliseconds: number | undefined): string {
    if (typeof milliseconds !== "number") return "";
    if (milliseconds === 0) return "0ms";
    if (milliseconds < 0) {
        return "-" + formatTime(-milliseconds);
    }
    if (milliseconds < 1 / 1000) {
        return formatMaxDecimals(milliseconds * 1000 * 1000, 3) + "ns";
    } else if (milliseconds < 1) {
        return formatMaxDecimals(milliseconds * 1000, 3) + "us";
    } else if (milliseconds < 1000) {
        return formatMaxDecimals(milliseconds, 3) + "ms";
        // Use seconds until we have 10 minutes, as decimal minutes are confusing
    } else if (milliseconds < 1000 * 60 * 10) {
        return formatMaxDecimals(milliseconds / 1000, 3) + "s";
    } else if (milliseconds < 1000 * 60 * 60) {
        return formatMaxDecimals(milliseconds / 1000 / 60, 3) + "m";
    } else if (milliseconds < 1000 * 60 * 60 * 24) {
        return formatMaxDecimals(milliseconds / 1000 / 60 / 60, 3) + "h";
        // } else if (milliseconds < 1000 * 60 * 60 * 24 * 10) {
        //     let remaining = Math.round(milliseconds / 1000);
        //     let seconds = remaining % 60;
        //     remaining -= seconds;
        //     remaining /= 60;
        //     let minutes = remaining % 60;
        //     remaining -= minutes;
        //     remaining /= 60;
        //     let hours = remaining;
        //     remaining -= hours;
        //     remaining /= 24;
        //     let days = remaining;
        //     let time = `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
        //     if (days > 0) {
        //         if (days === 1) {
        //             time = `1 day ${time}`;
        //         } else {
        //             time = `${days} days ${time}`;
        //         }
        //     }
        //     return time;
    } else {
        let days = Math.round(milliseconds / 1000 / 60 / 60 / 24);
        return `${days} days`;
    }
}

export function getTargetDecimals(maxAbsoluteValue: number, targetDigits: number) {
    let intDigits = Math.floor(Math.log10(maxAbsoluteValue) + 1);
    if (intDigits < 0) intDigits = 1;
    let decimalDigits = targetDigits - intDigits;
    // Happens if the number is so close to having too many digits that Math.log10 rounds it over.
    if (decimalDigits < 0) {
        decimalDigits = 0;
    }
    return decimalDigits;
}

/** Adds decimal digits to reach digits. If the number is simply too large, it won't remove
 *      digits, there will instead just be no decimal point.
 */
export function formatMaxDecimals(num: number, targetDigits: number, maxAbsoluteValue?: number, exactDecimals?: number): string {
    if (typeof num !== "number") return "0";
    // toFixed has a max of 100 digits
    if (targetDigits > 100) targetDigits = 100;
    if (!Number.isFinite(num)) return num.toFixed(targetDigits);

    if (num < 0) return formatMaxDecimals(-num, targetDigits, maxAbsoluteValue, exactDecimals);

    // TIMING:
    //  ~50ns   toString
    //  ~400ns  toLocaleString
    //  ~500ns  toLocaleString("en-us")
    //  ~20us   toLocaleString("en-us", { maximumFractionDigits: 2 })
    // So, we are avoiding using toLocaleString, for now.

    maxAbsoluteValue = maxAbsoluteValue ?? Math.abs(num);

    let targetDecimals = exactDecimals ?? getTargetDecimals(maxAbsoluteValue, targetDigits);
    let text = num.toFixed(targetDecimals);
    let parts = text.split(".");
    let integer = parts[0];
    let decimals = parts[1] ?? "";

    if (exactDecimals) {
        while (decimals.length < exactDecimals) {
            decimals += "0";
        }
    } else {
        while (decimals[decimals.length - 1] === "0") {
            decimals = decimals.slice(0, -1);
        }
    }

    let output = "";

    // NOTE: ONLY add comma groups if it is > 4 digits. As 4234K is easily read, and commas
    //  only really matter for numbers such as 4234523K, which is hard to read.
    if (integer.length > 4) {
        for (let i = integer.length; i > 0; i -= 3) {
            let start = i - 3;
            if (start < 0) start = 0;
            let str = integer.slice(start, i);
            if (output) {
                output = "," + output;
            }
            output = str + output;
        }
    } else {
        output = integer;
    }

    if (decimals) {
        output += "." + decimals;
    }

    return output;
}

/** Actually formats any number, including decimals, by using K, M and B suffixes to get smaller values
 *      TODO: Support uK, uM and uB suffixes for very small numbers?
 */
export function formatNumber(count: number | undefined, maxAbsoluteValue?: number, noDecimal?: boolean, specialCurrency?: boolean): string {
    if (typeof count !== "number") return "0";
    if (count < 0) {
        return "-" + formatNumber(-count, maxAbsoluteValue, noDecimal, specialCurrency);
    }

    maxAbsoluteValue = maxAbsoluteValue ?? Math.abs(count);

    // NOTE: We don't switch units as soon as we possible can, because...
    //  3.594 vs 3.584 is harder to quickly distinguish compared to 3594 and 3584,
    //  the decimal simply makes it harder to read, and larger.
    const extraFactor = 10;
    let divisor = 1;
    let suffix = "";
    let currencyDecimalsNeeded = false;
    if (maxAbsoluteValue < 1000 * extraFactor) {
        if (specialCurrency) {
            currencyDecimalsNeeded = true;
        }
    } else if (maxAbsoluteValue < 1000 * 1000 * extraFactor) {
        suffix = "K";
        divisor = 1000;
    } else if (maxAbsoluteValue < 1000 * 1000 * 1000 * extraFactor) {
        suffix = "M";
        divisor = 1000 * 1000;
    } else {
        suffix = "B";
        divisor = 1000 * 1000 * 1000;
    }
    count /= divisor;
    maxAbsoluteValue /= divisor;

    let maxDecimals = noDecimal ? 0 : 3;

    return formatMaxDecimals(count, maxDecimals, maxAbsoluteValue, currencyDecimalsNeeded ? 2 : undefined) + suffix;
}