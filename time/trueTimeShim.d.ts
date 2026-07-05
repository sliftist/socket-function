export type TimeOffsetProof = {
    sendTime: number;
    receiveTime: number;
    serverTime: number;
    offset: number;
};
export type TimeOffsetMeasurement = {
    offset: number;
    proof?: TimeOffsetProof;
};
export declare function getTimeComponentsDetailed(): {
    systemTime: number;
    fromOffset: number;
    toOffset: number;
    fromTime: number;
    toTime: number;
};
export declare function computeTweenedOffset(components: {
    systemTime: number;
    fromOffset: number;
    toOffset: number;
    fromTime: number;
}): number;
export declare function getTimeComponents(): {
    systemTime: number;
    offset: number;
};
export declare function getTrueTime(): number;
export declare function getTrueTimeOffset(): number;
export type TrueTimeProof = {
    systemTime: number;
    fromOffset: number;
    toOffset: number;
    fromTime: number;
    toTime: number;
    offset: number;
    measurement?: TimeOffsetProof;
};
export declare function getTrueTimeProof(): TrueTimeProof | undefined;
export declare function waitForFirstTimeSync(): Promise<void> | undefined;
declare global {
    var TRUE_TIME_ALREADY_SHIMMED: boolean;
}
export declare function shimDateNow(): void;
export declare function getBrowserTime(): number;
export declare function setGetTimeOffsetBase(base: () => Promise<number | TimeOffsetMeasurement>): void;
