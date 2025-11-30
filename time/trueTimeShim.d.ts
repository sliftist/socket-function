export declare function getTrueTime(): number;
export declare function getTrueTimeOffset(): number;
export declare function waitForFirstTimeSync(): Promise<void> | undefined;
export declare function shimDateNow(): void;
export declare function getBrowserTime(): number;
export declare function setGetTimeOffsetBase(base: () => Promise<number>): void;
