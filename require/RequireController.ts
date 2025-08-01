/// <reference path="../../typenode/index.d.ts" />
import debugbreak from "debugbreak";
import fs from "fs";
import { SocketFunction } from "../SocketFunction";
import { getCurrentHTTPRequest, setHTTPResultHeaders } from "../src/callHTTPHandler";
import { formatNumberSuffixed, isNode, isNodeTrue, sha256Hash, sha256HashPromise } from "../src/misc";
import zlib from "zlib";
import { cacheLimited, lazy } from "../src/caching";
import { formatNumber } from "../src/formatting/format";
import { requireMain } from "./require";
import path from "path";

const COMPRESS_CACHE_SIZE = 1024 * 1024 * 128;

module.allowclient = true;

declare global {
    namespace NodeJS {
        interface Module {
            /** Indicates the module is allowed clientside. */
            allowclient?: boolean;

            /** Causes the module to not preload, requiring `await import()` for it to load correctly
             *      - Shouldn't be set recursively, otherwise nested packages will break.
             */
            lazyload?: boolean;

            /** Indicates the module is definitely not allowed clientside */
            serveronly?: boolean;

            // TODO: Move seqNum into the actual compilation, and make it increment,
            //  so the clientside can properly handle race conditions during hot reloading.
            //  And... maybe it is useful in other cases?
            /** Used internally by RequireController */
            requireControllerSeqNum?: number;

            // Times are both unique (two modules evaluated at the same Date.now() will have different values).
            evalStartTime?: number;
            evalEndTime?: number;

            /** (Presently only called by require.js)
             *      Called on require calls, to allow providers to create custom exports depending on the caller.
             *          - Mostly used to allow functions to know the calling module.
             */
            remapExports?: (exports: { [key: string]: unknown }, callerModule: NodeJS.Module) => { [key: string]: unknown };

            /** Only set if clientside (and allowed clientside) */
            source?: string;
        }
    }
    interface Window {
        clientsideBootTime: number;
    }
    var suppressUnexpectedModuleWarning: number | undefined;
}

/** Imports it, serverside, delayed. For dynamic imports, which we need to include once, but don't want to include
 *      immediately (due to cyclic issues), and isn't included initially.
 */
export function lazyImport(getModule: () => Promise<unknown>) {
    if (!isNode()) return;
    // Import it, asynchronously, so it isn't preloaded, but it is available for clientside imports.
    //  NOTE: We track delayed imports (somewhere), and don't preload them by default in RequireController.
    void Promise.resolve().then(() => getModule());
}


let nextModuleSeqNum = 1;

const requireSeqNumProcessId = "requireSeqNumProcessId_" + Date.now() + "_" + Math.random();

const BEFORE_ENTRY_TEMPLATE = "<!-- BEFORE_ENTRY_TEMPLATE -->";
const ENTRY_TEMPLATE = "<!-- ENTRY_TEMPLATE -->";

const resolvedHTMLFile = lazy(() => {
    const bufferShim = fs.readFileSync(__dirname + "/buffer.js").toString();
    return fs.readFileSync(__dirname + "/require.html").toString()
        .replace(BEFORE_ENTRY_TEMPLATE,
            `
                <script>${bufferShim}</script>
                <script>(${requireMain.toString()})()</script>

                ${BEFORE_ENTRY_TEMPLATE}
            `
        );
});

let beforeEntryText: (string | (() => Promise<string>))[] = [];
function injectHTMLBeforeStartup(text: string | (() => Promise<string>)) {
    beforeEntryText.push(text);
}

type GetModulesResult = ReturnType<RequireControllerBase["getModules"]> extends Promise<infer T> ? T : never;
export type GetModulesArgs = Parameters<RequireControllerBase["getModules"]>;
let mapGetModules: {
    remap(result: GetModulesResult, args: GetModulesArgs): Promise<GetModulesResult>
}[] = [];
function addMapGetModules(remap: typeof mapGetModules[number]["remap"]) {
    mapGetModules.push({ remap });
}

class RequireControllerBase {
    public rootResolvePath = "";

    public async requireHTML(config?: {
        requireCalls?: string[];
        cacheTime?: number;
    }) {
        if (!this.rootResolvePath) {
            let dir = path.resolve(".");
            dir = dir.replaceAll("\\", "/");
            this.rootResolvePath = dir;
        }
        let { requireCalls, cacheTime } = config || {};
        let result = resolvedHTMLFile();
        if (beforeEntryText.length > 0) {
            let resolved: string[] = [];
            for (let text of beforeEntryText) {
                if (typeof text === "string") {
                    resolved.push(text);
                } else {
                    resolved.push(await text());
                }
            }
            result = result.replace(BEFORE_ENTRY_TEMPLATE, resolved.join("\n"));
        }
        if (requireCalls) {
            async function requireAll(calls: string[]) {
                // NOTE: awaiting isn't just for better and consistent load order, it also greatly improves load efficiency,
                //  as parallel calls can't know what files will be loaded, so there is a lot of duplicate loading. Loading
                //  1 at a time allows require to efficiently require only files that previous imports haven't loaded.
                for (let call of calls) {
                    try {
                        await require(call);
                    } catch (e) {
                        // Detach the error so we can continue
                        setTimeout(() => { throw e; });
                    }
                }
            }
            result = result.replace(ENTRY_TEMPLATE, `<script>\n(${requireAll.toString()})(${JSON.stringify(requireCalls)});\n</script>`);
        } else {
            result = result.replace(ENTRY_TEMPLATE, "");
        }
        let headers: Record<string, string> = {
            "Content-Type": "text/html"
        };
        if (cacheTime) {
            headers["Cache-Control"] = `max-age=${Math.floor(cacheTime / 1000)}`;
        }
        return setHTTPResultHeaders(Buffer.from(result), headers);
    }

    public async getModules(
        pathRequests: string[],
        alreadyHave?: {
            requireSeqNumProcessId: string;
            // NOTE: Highly optimized, as otherwise this can easily be KBs (I was seeing 9KB),
            //  which is uploaded, and so can be quite slow on slow connections.
            seqNumRanges: {
                s: number;
                // undefined means s + 1 (so just a single number)
                e?: number;
            }[];
        },
        config?: {}
    ): Promise<{
        requestsResolvedPaths: string[];
        modules: {
            [resolvedPath: string]: SerializedModule;
        };
        requireSeqNumProcessId: string;
    }> {
        let httpRequest = getCurrentHTTPRequest();

        let seqNums: { [seqNum: number]: 1 } = {};
        if (alreadyHave?.requireSeqNumProcessId === requireSeqNumProcessId) {
            for (let { s, e } of alreadyHave.seqNumRanges) {
                if (e === undefined) {
                    e = s + 1;
                }
                for (let i = s; i < e; i++) {
                    seqNums[i] = 1;
                }
            }
        }

        let modules: {
            [resolvedPath: string]: SerializedModule;
        } = Object.create(null);
        function addModule(module: NodeJS.Module, rootImport = false) {
            if (!rootImport && module.lazyload) return;
            if (!module.requireControllerSeqNum) {
                module.requireControllerSeqNum = nextModuleSeqNum++;
            }
            if (seqNums[module.requireControllerSeqNum]) {
                return;
            }
            if (module.filename in modules) return;

            // TODO: Remove unused exports. We know why the module is being requested, so we can
            //  actually very effectively know which exports it has which will never be used.
            //  - Of course, we would need to make the module specially, so if any new modules
            //      use it we can know... what was removed? It becomes complicated with
            //      lazy modules, but... it is still very important.

            // IMPORTANT! Use module.filename, to strip the ".CLIENT_NAMEPSACE" extension
            modules[module.filename] = {
                originalId: module.id,
                filename: module.filename,
                // NOTE: Due to recursive sets of allowclient, it is very possible for allowclient && serveronly to be set.
                allowclient: module.allowclient && !module.serveronly,
                serveronly: module.serveronly,
                requests: Object.create(null),
                seqNum: module.requireControllerSeqNum,
                size: module.size,
                version: module.version,
                asyncRequests: module.asyncRequires || {},
                flags: {},
            };
            let flags = modules[module.filename].flags!;
            for (let [flag, value] of Object.entries(module)) {
                if (value === true) {
                    flags[flag] = value;
                }
            }
            let moduleObj = modules[module.filename];
            if (moduleObj.allowclient) {
                moduleObj.source = module.moduleContents;
                if (module.filename.endsWith(".json") && !moduleObj.source) {
                    moduleObj.source = module.moduleContents = fs.readFileSync(module.filename).toString();
                }
            }

            // NOTE: Iterate on children even if it isn't allowed client, as the module may have children
            //  that are allowed clientside, and that have side-effects! (Mostly for static resources)
            //  - Surprisingly, this only increases the returned size by about 8% (probably more like 16%
            //      if we turn source maps off), so... it's fine. And with compression most of the extra
            //      size will go away, as paths are highly repetitive.
            //      - And now it increases the size by much less, as we ignore any subtree which are entirely
            //          not allowed on the client.
            for (let request in module.requires) {

                let requireResolvedPath = module.requires[request];
                let requiredModule = require.cache[requireResolvedPath];

                if (requiredModule) {
                    // Only include synchronous modules. BUT, DO include the requests, so when/if the request is made
                    //  it can be resolved correctly.
                    if (!module.asyncRequires?.[request]) {
                        addModule(requiredModule);
                    }
                    moduleObj.requests[request] = requiredModule.filename;
                } else {
                    moduleObj.requests[request] = "";
                }
            }
        }

        let searchPaths: string[] = [];
        {
            searchPaths.push(this.rootResolvePath);
            let pathParts = this.rootResolvePath.replaceAll("\\", "/").split("/");
            for (let i = 0; i < pathParts.length; i++) {
                // Skip empty path parts, to preventing the case where the path ends
                //  with a /, which would result in "D:/test//node_modules"
                if (!pathParts[i]) continue;
                searchPaths.push(pathParts.slice(0, i + 1).join("/") + "/node_modules");
            }
        }


        let requestsResolvedPaths: string[] = [];
        for (let pathRequest of pathRequests) {
            let resolvedPath = "";
            try {
                resolvedPath = require.resolve(pathRequest, { paths: searchPaths });
            } catch { }
            requestsResolvedPaths.push(resolvedPath);

            function createNotFoundModule(error: string): NodeJS.Module {
                console.warn(error);
                return {
                    exports: {},
                    children: [],
                    filename: resolvedPath,
                    id: resolvedPath,
                    isPreloading: false,
                    require: null as any,
                    loaded: true,
                    load: null as any,
                    parent: undefined,
                    path: "",
                    paths: [],
                    requires: {},
                    asyncRequires: {},
                    allowclient: true,
                    moduleContents: `console.warn(${JSON.stringify(error)})`,
                };
            }

            // TODO: We could use import() here... but that would only make the root call asynchronous,
            //  which wouldn't prevent synchronous blocking by that much anyway...
            //require(rootPath);
            let clientModule = require.cache[resolvedPath];
            if (!clientModule) {
                // NOTE: Root requires will be asynchronous, so throwing should be just as good as
                //  warning, except throwing can be caught and retried on another server.
                throw new Error(`Module ${pathRequest} (resolved to ${JSON.stringify(resolvedPath)}) was not included serverside. Resolved from root dir ${JSON.stringify(this.rootResolvePath)} (set by call to setRequireBootRequire), resolve search paths: ${JSON.stringify(searchPaths)})}`);
            }
            if (!clientModule.allowclient) {
                clientModule = createNotFoundModule(`Module ${pathRequest} (resolved to ${resolvedPath}) is not allowed clientside (set module.allowclient in it, or call setFlag when it is imported).`);
            }

            addModule(clientModule, true);
        }

        let result: GetModulesResult = { requestsResolvedPaths, modules, requireSeqNumProcessId };
        for (let remap of mapGetModules) {
            result = await remap.remap(result, [pathRequests, alreadyHave, config]);
        }

        // NOTE: Handling compression ourself allows us to efficiently cache (otherwise caching would require
        //      hashing the output, which takes almost as long as compression!)
        if (httpRequest && SocketFunction.HTTP_COMPRESS && httpRequest.headers["accept-encoding"]?.includes("gzip")) {
            let simplifiedResult = {
                ...result,
                modules: Object.entries(result.modules).map(x => [x[0], {
                    filename: x[1].filename,
                    version: x[1].version,
                    sourceLength: x[1].source?.length,
                }]),
            };
            let key = sha256Hash(JSON.stringify(simplifiedResult));
            let uncompressedBuffer = Buffer.from(JSON.stringify(result));
            let buffer = await compressCached(key, () => uncompressedBuffer);
            setHTTPResultHeaders(buffer, {
                "Content-Type": "application/json",
                "Content-Encoding": "gzip",
                "Content-Length": buffer.length.toString(),
                "X-Uncompressed-Content-Length": uncompressedBuffer.length.toString(),
            });
            return buffer as any;
        }

        return result;
    }
}

let compressCacheSize = 0;
let compressCache = new Map<string, Buffer>();
async function compressCached(bufferKey: string, buffer: () => Buffer): Promise<Buffer> {
    let cached = compressCache.get(bufferKey);
    if (!cached) {
        cached = await new Promise<Buffer>((resolve, reject) => {
            zlib.gzip(buffer(), {}, (err, result) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(result);
                }
            });
        });
        compressCacheSize += cached.length;
        // TODO: Make the cache LRU eviction, instead of just resetting it
        if (compressCacheSize > COMPRESS_CACHE_SIZE) {
            compressCache.clear();
            compressCacheSize = cached.length;
        }
        compressCache.set(bufferKey, cached);
    }
    return cached;
}

type ClientRemapCallback = (args: GetModulesArgs) => Promise<GetModulesArgs>;
declare global {
    /** Must be set clientside BEFORE requests are made (so you likely want to use RequireController.addMapGetModules
     *      to inject code that will use this) */
    var remapImportRequestsClientside: undefined | ClientRemapCallback[];
}

let baseController = new RequireControllerBase();
/** @deprecated, not needed, as this defaults to ".", which is a lot easier to reason about anyways. */
export function setRequireBootRequire(dir: string) {
    dir = path.resolve(dir);
    dir = dir.replaceAll("\\", "/");
    if (!dir.endsWith("/")) {
        dir += "/";
    }
    baseController.rootResolvePath = dir;
}

export const RequireController = SocketFunction.register(
    "RequireController-e2f811f3-14b8-4759-b0d6-73f14516cf1d",
    baseController,
    () => ({
        getModules: {},
        requireHTML: {},
        bufferJS: {},
        requireJS: {},
    }),
    undefined,
    {
        noAutoExpose: true,
        statics: {
            injectHTMLBeforeStartup,
            addMapGetModules,
        }
    }
);