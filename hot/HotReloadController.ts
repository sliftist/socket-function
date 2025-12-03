/// <reference path="../../typenode/index.d.ts" />
/// <reference path="../require/RequireController.ts" />
module.allowclient = true;

import { SocketFunction } from "../SocketFunction";
import { cache, lazy } from "../src/caching";
import * as fs from "fs";
import crypto from "crypto";
import debugbreak from "debugbreak";
import { isNode } from "../src/misc";
import { magenta, red } from "../src/formatting/logColors";
import { formatTime } from "../src/formatting/format";
import { batchFunction } from "../src/batching";
import { getIsAllowClient } from "../require/RequireController";

/** Enables some hot reload functionality.
 *      - Triggers a refresh clientside
 *      - Triggers a reload server, for modules marked with `module.hotreload`
 */
export function watchFilesAndTriggerHotReloading(noAutomaticBrowserWatch = false) {
    SocketFunction.expose(HotReloadController);
    if (!isNode()) {
        if (!noAutomaticBrowserWatch) {
            HotReloadController.nodes[SocketFunction.browserNodeId()]
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

let isHotReloadingValue = false;
export function isHotReloading() {
    return isHotReloadingValue;
}
globalThis.isHotReloading = isHotReloading;
export function hotReloadingGuard(): true {
    return !isHotReloading() as any;
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
    if (module.hotreload) {
        interval = 10;
        fast = true;
    }

    let lastHashes = new Map<string, string>();
    function getHash(path: string) {
        try {
            let contents = fs.readFileSync(path, "utf8");
            return crypto.createHash("sha256").update(contents).digest("hex");
        } catch {
            return "";
        }
    }

    watchFile(module.filename);
    for (let path of module.watchAdditionalFiles || []) {
        watchFile(path);
    }

    function watchFile(path: string) {
        lastHashes.set(path, getHash(path));
        fs.watchFile(path, { persistent: false, interval }, (curr, prev) => {
            let newHash = getHash(path);
            if (newHash === lastHashes.get(path)) return;
            lastHashes.set(path, newHash);
            if (path === module.filename) {
                console.log(`Hot reloading ${module.filename} due to change`);
            } else {
                console.log(`Hot reloading ${module.filename} due to change in ${path}`);
            }
            doHotReload(curr.mtimeMs);
        });
    }



    // IMPORTANT! changeTime is for benchmarking how long we took to hotreload (and nothing else)
    function doHotReload(changeTime: number) {
        module.updateContents?.();
        if (isNode() && !module.noserverhotreload) {
            if (
                module.hotreload
                // A fairly big hack (as this could just be in a string, or something similar), but... it also VERY useful
                || module.moduleContents?.includes("\nmodule.hotreload = true;" + "\n")
                || module.moduleContents?.includes("\r\nmodule.hotreload = true;" + "\r\n")
            ) {
                console.log(`Serverside reloading ${module.id}`);
                isHotReloadingValue = true;
                try {
                    module.loaded = false;
                    module.load(module.id);
                } catch (e) {
                    console.error(red(`Error hot reloading ${module.id}`));
                    console.error(e);
                } finally {
                    setTimeout(() => {
                        isHotReloadingValue = false;
                    }, 1000);
                }
            }
            for (let callback of hotReloadCallbacks) {
                callback([module]);
            }
        }
        //module.sourceSHA256;
        // crypto.createHash("sha256").update(contents).digest("hex")
        if (getIsAllowClient(module)) {
            triggerClientSideReload({
                files: [module.filename],
                changeTime,
                fast,
            });
        }
    }
});
let reloadTriggering = false;
let clientWatcherNodes = new Set<string>();
let pendingTriggerFiles = new Set<string>();
function triggerClientSideReload(config: {
    files: string[];
    changeTime: number;
    fast?: boolean;
}) {
    for (let file of config.files) {
        pendingTriggerFiles.add(file);
    }
    if (reloadTriggering) return;
    reloadTriggering = true;
    setTimeout(async () => {
        reloadTriggering = false;
        let files = Array.from(pendingTriggerFiles);
        pendingTriggerFiles.clear();
        for (let clientNodeId of clientWatcherNodes) {
            console.log(`Notifying client of hot reload: ${clientNodeId}`, files);
            HotReloadController.nodes[clientNodeId].fileUpdated(files, config.changeTime).catch(() => {
                console.log(`Removing erroring client: ${clientNodeId}`);
                clientWatcherNodes.delete(clientNodeId);
            });
        }
        // We need to wait, otherwise batched updates fail, WHICH, can result in updates while reloading,
        //  which causes missed updates.
    }, config.fast ? 50 : 300);
}

class HotReloadControllerBase {
    // TODO: Also hot reload when we reconnect to the server, as it is likely setup will need to
    //  be rerun in that case as well (for example, we need to call watchFiles again!)
    async watchFiles() {
        let callerId = SocketFunction.getCaller().nodeId;
        clientWatcherNodes.add(callerId);
    }
    // TODO: This is actually broken related to lazy loaded and server-only code, as the server will tell us a file changed, and then we'll see that we don't have it loaded, and so we will try to refresh.
    //      - The reason we refresh is because it might be a new file. I don't know how we could check to see if it was lazy loaded. Maybe we just shouldn't refresh ever if we can't find the module? We'll see how much we run into the extra refresh due to lazy loading...
    async fileUpdated(files: string[], changeTime: number) {
        try {
            console.groupCollapsed(magenta(`Trigger hotreload for files ${formatTime(Date.now() - changeTime)} after file change`));
            for (let file of files) {
                console.log(file);
            }
            console.groupEnd();
            let modules: NodeJS.Module[] = [];
            for (let file of files) {
                file = "https://" + (BOOTED_EDGE_NODE?.host || location.host) + "/" + file;
                let module = require.cache[file];
                if (!module) {
                    console.log(`Module not found: ${file}, reloading page to ensure new version is loaded`);
                    document.location.reload();
                    return;
                }
                if (!module.hotreload) {
                    console.log(`Module not hotreloadable: ${file}, reloading page to ensure new version is loaded`);
                    document.location.reload();
                    return;
                }
                modules.push(module);
            }
            for (let module of modules) {
                module.loaded = false;
            }
            isHotReloadingValue = true;
            try {
                await Promise.all(modules.map(module => module.load(module.filename)));
            } finally {
                setTimeout(() => {
                    isHotReloadingValue = false;
                }, 1000);
            }

            for (let callback of hotReloadCallbacks) {
                callback(modules);
            }
            console.log(magenta(`Hot reload complete ${formatTime(Date.now() - changeTime)} after file change`));
        } catch (e: any) {
            console.error(`Hot reload failed ${e.stack}`);
        }
    }
}

export const HotReloadController = SocketFunction.register(
    "HotReloadController-032b2250-3aac-4187-8c95-75412742b8f5",
    new HotReloadControllerBase(),
    () => ({
        watchFiles: {},
        fileUpdated: {}
    }),
    () => ({

    }),
    {
        noAutoExpose: true,
    }
);