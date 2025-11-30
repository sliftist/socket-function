export type OwnTimeObj = {
    name: string;
    time: number;
    ownTime: number;
};
export type OwnTimeObjInternal = OwnTimeObj & {
    lastStartTime: number;
    firstStartTime: number;
};
export declare function getOpenTimesBase(): OwnTimeObjInternal[];
export declare const measureOverheadTime: number;
export declare function getOwnTime<T>(name: string, code: () => T, onTime: (obj: OwnTimeObj) => void): T;
