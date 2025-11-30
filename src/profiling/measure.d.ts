import { StatsValue } from "./stats";
/** NOTE: Must be called BEFORE anything else is imported!
 *      NOTE: Measurements on on by default now, so this doesn't really need to be called...
*/
export declare function enableMeasurements(): void;
/** NOTE: Must be called BEFORE anything else is imported! */
export declare function disableMeasurements(): void;
export declare function measureFnc(target: any, propertyKey: string, descriptor: PropertyDescriptor): void;
export declare function nameFunction<T extends Function>(name: string, fnc: T): T;
export declare function measureWrap<T extends (...args: any[]) => any>(fnc: T, name?: string): T;
export declare function measureBlock<T extends (...args: any[]) => any>(fnc: T, name?: string): ReturnType<T>;
/** NOTE: You should often call registerNodeMetadata for this as well. registerMeasureInfo
 *      is for logs, while registerNodeMetadata is for the overview page.
 */
export declare function registerMeasureInfo(getInfo: () => string | undefined): void;
/** IMPORTANT! Always finish the profile! If you don't, you will leak A LOT of memory
 *      (you leak all future measures, PER unfinished profile)!
 */
export declare function startMeasure(): {
    finish: () => MeasureProfile;
};
export interface LogMeasureTableConfig {
    useTotalTime?: boolean;
    name?: string;
    setTitle?: boolean;
    thresholdInTable?: number;
    minTimeToLog?: number;
    mergeDepth?: number;
    maxTableEntries?: number;
    returnOnly?: boolean;
}
export interface FormattedMeasureTable {
    title: string;
    entries: {
        name: string;
        ownTime: number;
        fraction: number;
        equation: string;
    }[];
}
export declare function logMeasureTable(profile: MeasureProfile, config?: LogMeasureTableConfig): FormattedMeasureTable | undefined;
export declare function measureCode<T>(code: () => Promise<T>, config?: LogMeasureTableConfig): Promise<T>;
export declare function measureCodeSync<T>(code: () => T, config?: LogMeasureTableConfig): T;
export interface MeasureProfile {
    startTime: number;
    endTime: number;
    entries: {
        [name: string]: ProfileEntry;
    };
}
export declare function createMeasureProfile(): MeasureProfile;
export declare function addToMeasureProfile(base: MeasureProfile, other: MeasureProfile): void;
interface ProfileEntry {
    name: string;
    ownTime: StatsValue;
    totalTime: StatsValue;
    stillOpenCount: number;
}
export {};
