/// <reference path="../src/src.d.ts" />
declare global {
    var onProgressHandler: undefined | ((progress: {
        type: string;
        addValue: number;
        addMax: number;
    }) => void);
    var onErrorHandler: undefined | ((error: string) => void);
    var BOOT_TIME: number;
    var builtInModuleExports: {
        [key: string]: unknown;
    };
}
export declare function requireMain(): void;
