import { formatTime, formatNumber } from "../formatting/format";
import { red, white } from "../formatting/logColors";
import { isNode } from "../misc";
import { StatsValue, getStatsTop } from "./stats";

export function percent(value: number) {
    return `${(value * 100).toFixed(2)}%`;
}

export function formatStats(stats: StatsValue, config?: {
    noColor?: boolean;
    noSum?: boolean;
    noSpaces?: boolean;
}) {
    function p(count: number, text: string | number) {
        return String(text).padStart(count, " ");
    }

    let perText = formatTime(stats.sum / stats.count);
    let countText = formatNumber(stats.count);
    let sumText = formatTime(stats.sum);
    let equation = (!config?.noSum && `${p(6, sumText)} =  ` || "") + `${p(6, countText)} * ${p(6, perText)}`;

    let top = getStatsTop(stats);
    if (top.topHeavy) {
        let topText = formatTime(top.value / top.count);
        let topCountText = formatNumber(top.count);
        let bottomText = formatTime((stats.sum - top.value) / (stats.count - top.count) || 0);
        let bottomCountText = formatNumber(stats.count - top.count);
        let topPart = `${topCountText} * ${p(6, topText)}`;
        let bottomPart = `${bottomCountText} * ${bottomText}`;
        if (!config?.noColor) {
            if (isNode()) {
                topPart = red(topPart);
            } else {
                bottomPart = white(bottomPart);
            }
        }
        equation = (!config?.noSum && `${p(6, sumText)} = ` || "") + `${p(6, topPart)}   +  ${bottomPart}`;
    }
    if (config?.noSpaces) {
        equation = equation.replace(/\s+/g, " ").trim();
    }
    return equation;
}