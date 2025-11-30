/// <reference path="../../typenode/index.d.ts" />
/// <reference path="../require/RequireController.d.ts" />
/** Enables some hot reload functionality.
 *      - Triggers a refresh clientside
 *      - Triggers a reload server, for modules marked with `module.hotreload`
 */
export declare function watchFilesAndTriggerHotReloading(noAutomaticBrowserWatch?: boolean): void;
declare global {
    namespace NodeJS {
        interface Module {
            /** Causes us to hotreload the file. Applies both serverside and clientside.
             *      - If not set for any files clientside, we will refresh.
             *      - If not set for any files serverside, we will do nothing (and just leave old code running).
             */
            hotreload?: boolean;
            /** Overrides hotreload to disable hot reloading. Useful if you add "hotreload.flag" to a directory
             *      (which sets hotreload on all files in and under that directory), but want a specific file
             *      to not hotreload.
             *  - Also useful if you want files to hotreload clientside, but not serverside.
             */
            noserverhotreload?: boolean;
            watchAdditionalFiles?: string[];
        }
    }
    var isHotReloading: (() => boolean) | undefined;
}
export declare function isHotReloading(): boolean;
export declare function hotReloadingGuard(): true;
export declare function setExternalHotReloading(value: boolean): void;
export declare function onHotReload(callback: (modules: NodeJS.Module[]) => void): void;
export declare const HotReloadController: import("../SocketFunctionTypes").SocketRegistered<{
    watchFiles: () => Promise<void>;
    fileUpdated: (files: string[], changeTime: number) => Promise<void>;
}>;
