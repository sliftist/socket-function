/// <reference path="../../typenode/index.d.ts" />
/// <reference path="../require/RequireController.ts" />
module.allowclient = true;

import { SocketFunction } from "../SocketFunction";
import { cache, lazy } from "../src/caching";
import * as fs from "fs";
import debugbreak from "debugbreak";
import { isNode } from "../src/misc";
import { magenta, red } from "../src/formatting/logColors";

/** Enables some hot reload functionality.
 *      - Triggers a refresh clientside
 *      - Triggers a reload server, for modules marked with `module.hotreload`
 */
export function watchFilesAndTriggerHotReloading(noAutomaticBrowserWatch = false) {

    SocketFunction.expose(HotReloadController);
    if (!isNode()) {
        if (!noAutomaticBrowserWatch) {
            HotReloadController.nodes[SocketFunction.locationNode()]
                .watchFiles()
                .catch(e => console.error("watchFiles error", e))
                ;
        }
    }
    setInterval(() => {
        for (let module of Object.values(require.cache)) {
            if (!module) continue;
            hotReloadModule(module);
        }
    }, 5000);
}

declare global {
    namespace NodeJS {
        interface Module {
            /** Causes us to hotreload the file. Applies both serverside and clientside.
             *      - If not set for any files clientside, we will refresh.
             *      - If not set for any files serverside, we will do nothing (and just leave old code running).
             */
            hotreload?: boolean;
            /** Only hotreloads the file in the browser. */
            hotreloadBrowser?: boolean;
        }
    }
}

let isHotReloadingValue = false;
export function isHotReloading() {
    return isHotReloadingValue;
}
export function setExternalHotReloading(value: boolean) {
    isHotReloadingValue = value;
}
let hotReloadCallbacks: ((modules: NodeJS.Module[]) => void)[] = [];
export function onHotReload(callback: (modules: NodeJS.Module[]) => void) {
    hotReloadCallbacks.push(callback);
}

const hotReloadModule = cache((module: NodeJS.Module) => {
    if (!module.updateContents) return;
    let interval = 1000;
    let fast = false;
    if (module.hotreload || module.hotreloadBrowser) {
        interval = 10;
        fast = true;
    }
    fs.watchFile(module.filename, { persistent: false, interval }, (curr, prev) => {
        if (curr.mtime.getTime() === prev.mtime.getTime()) return;
        console.log(`Hot reloading due to change: ${module.filename}`);
        module.updateContents?.();
        if (isNode()) {
            if (
                module.hotreload
                // A fairly big hack (as this could just be in a string, or something similar), but... it also VERY useful
                || module.moduleContents?.includes("\nmodule.hotreload = true;" + "\n")
                || module.moduleContents?.includes("\r\nmodule.hotreload = true;" + "\r\n")
            ) {
                console.log(`Reloading ${module.id}`);
                isHotReloadingValue = true;
                try {
                    module.loaded = false;
                    module.load(module.id);
                } catch (e) {
                    console.error(red(`Error hot reloading ${module.id}`));
                    console.error(e);
                } finally {
                    isHotReloadingValue = false;
                }
            }
        }
        triggerClientSideReload({
            files: [module.filename],
            changeTime: curr.mtimeMs,
            fast,
        });
    });
});
let reloadTriggering = false;
let clientWatcherNodes = new Set<string>();
function triggerClientSideReload(config: {
    files: string[];
    changeTime: number;
    fast?: boolean;
}) {
    if (reloadTriggering) return;
    reloadTriggering = true;
    setTimeout(async () => {
        reloadTriggering = false;
        for (let clientNodeId of clientWatcherNodes) {
            console.log(`Notifying client of hot reload: ${clientNodeId}`);
            HotReloadController.nodes[clientNodeId].fileUpdated(config.files, config.changeTime).catch(() => {
                console.log(`Removing erroring client: ${clientNodeId}`);
                clientWatcherNodes.delete(clientNodeId);
            });
        }
    }, config.fast ? 10 : 300);
}

class HotReloadControllerBase {
    // TODO: Also hot reload when we reconnect to the server, as it is likely setup will need to
    //  be rerun in that case as well (for example, we need to call watchFiles again!)
    async watchFiles() {
        let callerId = SocketFunction.getCaller().nodeId;
        clientWatcherNodes.add(callerId);
    }
    async fileUpdated(files: string[], changeTime: number) {
        console.groupCollapsed(magenta(`Trigger hotreload for files (${Date.now() - changeTime}ms after file change)`));
        for (let file of files) {
            console.log(file);
        }
        console.groupEnd();
        let modules: NodeJS.Module[] = [];
        for (let file of files) {
            let module = require.cache[file];
            if (!module) {
                console.log(`Module not found: ${file}, reloading page to ensure new version is loaded`);
                document.location.reload();
                return;
            }
            if (!module.hotreload && !module.hotreloadBrowser) {
                console.log(`Module not hotreloadable: ${file}, reloading page to ensure new version is loaded`);
                document.location.reload();
                return;
            }
            modules.push(module);
        }
        for (let module of modules) {
            module.loaded = false;
        }
        await Promise.all(modules.map(module => module.load(module.filename)));

        for (let callback of hotReloadCallbacks) {
            callback(modules);
        }
        console.log(magenta(`Hot reload complete (${Date.now() - changeTime}ms after file change)`));
    }
}

export const HotReloadController = SocketFunction.register(
    "HotReloadController-032b2250-3aac-4187-8c95-75412742b8f5",
    new HotReloadControllerBase(),
    () => ({
        watchFiles: {},
        fileUpdated: {}
    })
);