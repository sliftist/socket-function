/// <reference path="../../typenode/index.d.ts" />
/// <reference path="../require/RequireController.ts" />
module.allowclient = true;

import { SocketFunction } from "../SocketFunction";
import { cache, lazy } from "../src/caching";
import * as fs from "fs";

/** Hot reloads server and client files, just trigger a refresh clientside,
 *      while triggering per file re-evaluation and export updates serverside.
 *      - Requires HotReloadController to be exposed both serverside and clientside.
 */
export function watchFilesAndTriggerHotReloading() {
    setInterval(() => {
        for (let module of Object.values(require.cache)) {
            if (!module) continue;
            hotReloadModule(module);
        }
    }, 5000);
}


const hotReloadModule = cache((module: NodeJS.Module) => {
    if (!module.updateContents) return;
    fs.watchFile(module.filename, { persistent: false, interval: 1000 }, (curr, prev) => {
        if (curr.mtime.getTime() === prev.mtime.getTime()) return;
        console.log(`Hot reloading due to change: ${module.filename}`);
        module.updateContents?.();
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
        let callerId = HotReloadController.context.caller?.nodeId;
        if (!callerId) {
            throw new Error("No nodeId?");
        }
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