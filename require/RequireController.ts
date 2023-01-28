import debugbreak from "debugbreak";
import fs from "fs";
import { SocketFunction } from "../SocketFunction";
import { setHTTPResultHeaders } from "../src/callHTTPHandler";
import { isNodeTrue } from "../src/misc";

module.allowclient = true;

declare global {
    namespace NodeJS {
        interface Module {
            /** Indiciates the module is allowed clientside. */
            allowclient?: boolean;

            /** Indicates the module is definitely not allowed clientside */
            serveronly?: boolean;

            // TODO: Move seqNum into the actual compilation, and make it increment,
            //  so the clientside can properly handle race conditions during hot reloading.
            //  And... maybe it is useful in other cases?
            /** Used internally by RequireController */
            requireControllerSeqNum?: number;
        }
    }
    interface Window {
        clientsideBootTime: number;
    }
}

export interface SerializedModule {
    originalId: string;
    filename: string;
    // If a module is not allowed clientside it is likely requests will be empty,
    //  to save effort parsing requests for modules that only exist to give better
    //  error messages.
    requests: {
        // request => resolvedPath
        [request: string]: string;
    };
    // NOTE: IF !allowclient && !serveronly, it might just mean we didn't add allowclient
    //  to the module yet. BUT, if serveronly, then we know for sure we don't want it client.
    //  So the messages and behavior will be different.
    allowclient?: boolean;
    serveronly?: boolean;
    // Just for errors mostly
    alwayssend?: boolean;

    /** Only set if allowclient. */
    source?: string;

    seqNum: number;
}

let nextModuleSeqNum = 1;

const requireSeqNumProcessId = "requireSeqNumProcessId_" + Date.now() + "_" + Math.random();

const htmlFile = isNodeTrue() && fs.readFileSync(__dirname + "/require.html").toString();
const jsFile = isNodeTrue() && fs.readFileSync(__dirname + "/require.js").toString();
const bufferShim = isNodeTrue() && fs.readFileSync(__dirname + "/buffer.js").toString();

const resolvedHTMLFile = isNodeTrue() && (
    htmlFile
        .replace(`<script src="./buffer.js"></script>`, `<script>${bufferShim}</script>`)
        .replace(`<script src="./require.js"></script>`, `<script>${jsFile}</script>`)
);

class RequireControllerBase {
    public rootResolvePath = "";

    public async requireHTML(bootRequirePath?: string) {
        let result = resolvedHTMLFile;
        if (bootRequirePath) {
            result = result.replace(`<!-- ENTRY_TEMPLATE -->`, `<script>require(${JSON.stringify(bootRequirePath)});</script>`);
        }
        return setHTTPResultHeaders(Buffer.from(result), { "Content-Type": "text/html" });
    }

    public async bufferJS() {
        return setHTTPResultHeaders(Buffer.from(bufferShim), { "Content-Type": "text/javascript" });
    }
    public async requireJS() {
        return setHTTPResultHeaders(Buffer.from(jsFile), { "Content-Type": "text/javascript" });
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
    ): Promise<{
        requestsResolvedPaths: string[];
        modules: {
            [resolvedPath: string]: SerializedModule;
        };
        requireSeqNumProcessId: string;
    }> {
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
        function addModule(module: NodeJS.Module) {
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
            };
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
                    addModule(requiredModule);
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
                    allowclient: true,
                    moduleContents: `console.warn(${JSON.stringify(error)})`,
                };
            }

            // TODO: We could use import() here... but that would only make the root call asynchronous,
            //  which wouldn't prevent synchronous blocking by that much anyway...
            //require(rootPath);
            let clientModule = require.cache[resolvedPath];
            if (!clientModule) {
                clientModule = createNotFoundModule(`Module ${pathRequest} (resolved to ${JSON.stringify(resolvedPath)}) was not included serverside. Resolve root ${JSON.stringify(this.rootResolvePath)} (set by call to setRequireBootRequire), resolve search paths: ${JSON.stringify(searchPaths)})}`);
            }
            if (!clientModule.allowclient) {
                clientModule = createNotFoundModule(`Module ${pathRequest} (resolved to ${resolvedPath}) is not allowed clientside (set module.allowclient in it, or call setFlag when it is imported).`);
            }

            addModule(clientModule);
        }

        return { requestsResolvedPaths, modules, requireSeqNumProcessId };
    }
}

let baseController = new RequireControllerBase();
export function setRequireBootRequire(path: string) {
    baseController.rootResolvePath = path;
}

export const RequireController = SocketFunction.register(
    "RequireController-e2f811f3-14b8-4759-b0d6-73f14516cf1d",
    baseController,
    {
        getModules: {},
        requireHTML: {},
        bufferJS: {},
        requireJS: {},
    }
);