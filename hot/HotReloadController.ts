/// <reference path="../../typenode/index.d.ts" />
/// <reference path="../require/RequireController.ts" />
module.allowclient = true;

import { SocketFunction } from "../SocketFunction";
import { cache, lazy } from "../src/caching";
import * as fs from "fs";
import debugbreak from "debugbreak";
import { isNode } from "../src/misc";
import { red } from "../src/formatting/logColors";

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
            hotreload?: boolean;
            noserverhotreload?: boolean;
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

const hotReloadModule = cache((module: NodeJS.Module) => {
    if (!module.updateContents) return;
    fs.watchFile(module.filename, { persistent: false, interval: 1000 }, (curr, prev) => {
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
        triggerClientSideReload();
    });
});
let reloadTriggering = false;
let clientWatcherNodes = new Set<string>();
function triggerClientSideReload() {
    if (reloadTriggering) return;
    reloadTriggering = true;
    setTimeout(async () => {
        reloadTriggering = false;
        for (let clientNodeId of clientWatcherNodes) {
            console.log(`Notifying client of hot reload: ${clientNodeId}`);
            HotReloadController.nodes[clientNodeId].fileUpdated().catch(() => {
                console.log(`Removing erroring client: ${clientNodeId}`);
                clientWatcherNodes.delete(clientNodeId);
            });
        }
    }, 300);
}

class HotReloadControllerBase {
    // TODO: Also hot reload when we reconnect to the server, as it is likely setup will need to
    //  be rerun in that case as well (for example, we need to call watchFiles again!)
    async watchFiles() {
        let callerId = SocketFunction.getCaller().nodeId;
        clientWatcherNodes.add(callerId);
    }
    async fileUpdated() {
        document.location.reload();
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