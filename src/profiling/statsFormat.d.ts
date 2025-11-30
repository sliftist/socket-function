import { StatsValue } from "./stats";
export declare function percent(value: number): string;
export declare function formatStats(stats: StatsValue, config?: {
    noColor?: boolean;
    noSum?: boolean;
    noSpaces?: boolean;
}): string;
