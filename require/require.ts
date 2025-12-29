/// <reference path="../src/src.d.ts" />

import { GetModulesArgs } from "./RequireController";


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

export function requireMain() {
    async function requestText(endpoint: string, values: any) {
        let url = new URL(endpoint);

        let json = JSON.stringify(values);
        let response: Response;
        if (json.length < 6000) {
            // NOTE: Try to use a GET, as GETs can be cached! However, if the data is too large,
            //  we have to use a post, or else the request url will be too large
            for (let key in values) {
                url.searchParams.set(key, JSON.stringify(values[key]));
            }
            response = await fetch(url.toString(), {
                method: "GET",
                credentials: "include",
            });
        } else {
            response = await fetch(url.toString(), {
                method: "POST",
                body: json,
                credentials: "include",
            });
        }

        let compressionRatio = 1;
        let uncompressedLength = response.headers.get("X-Uncompressed-Content-Length");
        let compressedLength = response.headers.get("Content-Length");
        if (uncompressedLength && compressedLength) {
            compressionRatio = +uncompressedLength / +compressedLength;
        }
        let totalLength = +(uncompressedLength || compressedLength || 0);
        if (totalLength) {
            globalThis.onProgressHandler?.({
                type: "Download",
                addValue: 0,
                addMax: Math.floor(totalLength / compressionRatio),
            });
        }

        // If it's an error, set requestError
        if (!response.ok) {
            globalThis.onErrorHandler?.(response.statusText);
        }

        // Stream it, so we can get progrss
        let reader = response.body!.getReader();
        let result = "";
        while (true) {
            let { done, value } = await reader.read();
            if (done) break;
            result += new TextDecoder().decode(value);
            let cur = (value?.length || 0) / compressionRatio;
            globalThis.onProgressHandler?.({
                type: "Download",
                addValue: cur,
                addMax: 0,
            });
        }

        return result;
    }

    const g = globalThis as any;
    let startTime = Date.now();
    globalThis.BOOT_TIME = startTime;

    // Set to the first rootDomain, unless the first import does not have a domain
    let mainRootOrigin = location.origin + location.pathname;
    let isFirstImport = true;

    (Symbol as any).dispose = Symbol.dispose || Symbol("dispose");
    (Symbol as any).asyncDispose = Symbol.asyncDispose || Symbol("asyncDispose");

    // Globals
    Object.assign(window, {
        process: {
            argv: window?.process?.argv || [],
            env: {
                // Mirror the tnode.js setting
                NODE_ENV: "production",
            },
            versions: {},
        },
        setImmediate(callback: () => void) {
            setTimeout(callback, 0);
        },
        // Ignore flags for now, even though they should work fine if we just hardcoded compileFlags.ts here.
        setFlag() { },
        global: window,
    });

    // Not real modules, as we just define their exports
    const builtInModuleExports = {
        worker_threads: {
            isMainThread: true,
        },
        util: {
            // https://nodejs.org/api/util.html#util_util_inherits_constructor_superconstructor
            inherits(constructor: any, superConstructor: any) {
                Object.setPrototypeOf(constructor.prototype, superConstructor.prototype);
            },
            TextDecoder: TextDecoder,
            TextEncoder: TextEncoder,
        },
        buffer: { Buffer },
        stream: {
            // HACK: Needed to get SAX JS to work correctly.
            Stream: function () { },
            Transform: function () { },
        },
        timers: {
            // TODO: Add all members of timers
            setImmediate: window.setImmediate,
        },
        child_process: {},
        events: {},
    };
    globalThis.builtInModuleExports = globalThis.builtInModuleExports || {};
    Object.assign(globalThis.builtInModuleExports, builtInModuleExports);

    let lastTime = 0;
    function nextTime() {
        let time = Date.now();
        if (time <= lastTime) {
            // NOTE: We SHOULD really add epsilon, but... this is a lot easier, and is close enough,
            //  as times will never have too large of a magnitude.
            time = lastTime + 0.01;
        }
        lastTime = time;
        return time;
    }

    /** @type {{
        [resolvePath: string]: {
            // May be different then the module filename
            filename: string;
            // If a module is not allowed clientside it is likely requests will be empty,
            //  to save effort parsing requests for modules that only exist to give better
            //  error messages.
            requests: {
                // request => resolvedPath
                [request: string]: string;
            };
            asyncRequests: { [request: string]: true };
            // NOTE: IF !allowclient && !serveronly, it might just mean we didn't add allowclient
            //  to the module yet. BUT, if serveronly, then we know for sure we don't want it client.
            //  So the messages and behavior will be different.
            allowclient?: boolean;
            serveronly?: boolean;
    
            source?: string;
        }
    }} */
    let serializedModules: { [id: string]: SerializedModule | undefined } = Object.create(null);

    type ModuleType = NodeJS.Module & {
        id: string;
        filename: string;
        exports: unknown;
        children: ModuleType[];
        flags: { [key: string]: boolean };
        load: () => void;
        loaded: boolean;
        isPreloading: boolean;
        evalStartTime: number;
        evalEndTime: number | undefined;
        evaluateStarted: boolean;
        source: string;
        allowclient: boolean;
        size: number;
        original: SerializedModule;
        import: (request: string, asyncIsFine?: boolean) => unknown;
    };

    let moduleCache: { [id: string]: ModuleType } = Object.create(null);
    let alreadyHave: {
        requireSeqNumProcessId: string;
        seqNums: { [seqNum: string]: true | 1 | 0 | undefined };
    } | undefined;

    let rootResolveCache = Object.create(null);

    rootRequire.cache = moduleCache;
    // Expose require for debugging, not so it can be called
    g.require = rootRequire;
    g.import = rootRequire;

    g.r = function r(text: string) {
        text = text.toLowerCase();
        return Object.values(moduleCache).filter((x) => x.filename.toLowerCase().includes(text))[0].exports;
    };

    let requireBatch: { [request: string]: (() => void)[] } | undefined;
    function rootRequire(request: string, batch?: boolean): unknown {
        if (request.includes("file://")) {
            // How does this happen? It definitely breaks things, and we could remove the file://, but... how
            //  does it even happen?
            debugger;
        }
        if (isFirstImport) {
            isFirstImport = false;
            if (request.startsWith("https://")) {
                mainRootOrigin = getRootDomain(request);
            }
        }
        if (!request.startsWith("https://")) {
            request = mainRootOrigin + request;
        }

        if (!batch) {
            if (request in rootResolveCache) {
                let resolvedRequest = rootResolveCache[request];
                if (resolvedRequest in rootRequire.cache) {
                    return rootRequire.cache[resolvedRequest].exports;
                }
            }

            if (request in rootRequire.cache) {
                return rootRequire.cache[request].exports;
            }
        }

        if (request in builtInModuleExports) {
            return builtInModuleExports[request as keyof typeof builtInModuleExports];
        }
        if (batch) {
            if (!requireBatch) {
                requireBatch = requireBatch || {};
                setTimeout(() => {
                    if (!requireBatch) throw new Error("Impossible");
                    let requests = Object.keys(requireBatch);
                    let callbacks = Object.values(requireBatch).reduce((a, b) => a.concat(b), []);
                    requireBatch = undefined;
                    void rootRequireMultiple(requests).then(
                        () => {
                            for (let callback of callbacks) {
                                callback();
                            }
                        },
                        (err) => {
                            throw err;
                        }
                    );
                }, 0);
            }
            return new Promise<void>((resolve) => {
                if (!requireBatch) throw new Error("Impossible");
                requireBatch[request] = requireBatch[request] || [];
                requireBatch[request].push(resolve);
            });
        } else {
            return rootRequireMultiple([request]).then((x) => x[0].exports);
        }
    }

    function getRootDomain(request: string) {
        let url = new URL(request);
        let origin = url.origin;
        // Fix stupid :443 erasure (other ports aren't erased, except 80, but we'll never use HTTP,
        //  so that's fine).
        {
            let remaining = request.slice(origin.length);
            if (remaining.startsWith(":443/")) {
                origin += ":443";
            }
        }
        return origin + "/";
    }

    async function rootRequireMultiple(requests: string[]) {
        console.log(`%cimport(${requests.join(", ")}) at ${Date.now() - startTime}ms`, "color: orange");

        let time = Date.now();

        let alreadyHaveRanges;
        if (alreadyHave) {
            let seqNums = Object.keys(alreadyHave.seqNums).map((x) => +x);
            seqNums.sort((a, b) => a - b);
            let seqNumRanges: { s: number; e?: number }[] = [];
            alreadyHaveRanges = { requireSeqNumProcessId: alreadyHave.requireSeqNumProcessId, seqNumRanges };
            for (let seqNum of seqNums) {
                let prev = seqNumRanges[seqNumRanges.length - 1];
                if (prev?.e === seqNum) {
                    prev.e++;
                } else {
                    seqNumRanges.push({ s: seqNum, e: seqNum + 1 });
                }
            }
            for (let range of seqNumRanges) {
                if (range.s + 1 === range.e) {
                    delete range.e;
                }
            }
        }

        let domainOrigin = "";
        let originalRequests = requests;
        if (requests.some(x => x.startsWith("https://"))) {
            requests = requests.map((request) => {
                if (!request.startsWith("https://")) {
                    throw new Error(`Mixed domains with non-domain requests is not supported presently. Requests: ${requests.join(" | ")}`);
                }
                let origin = getRootDomain(request);
                if (domainOrigin && domainOrigin !== origin) {
                    // TODO: If this happens, we can probably just split the call up into multiple calls?
                    throw new Error(`Mixed domains in require call is not supported presently. Requests: ${requests.join(" | ")}`);
                }
                domainOrigin = origin;
                // By stripping by length, we can turn https://example.com/./test => "./test"
                //  (where as if we used pathname, it would turn into "/test"
                return request.slice(domainOrigin.length);
            });
        }

        let args: GetModulesArgs = [requests, alreadyHaveRanges];
        // We have to add hardcoded support for droppermissions, because... this call
        //  doesn't have the conventional persisted code sending code, because... it's
        //  all on its own.
        let searchParams = new URLSearchParams(location.search);
        if (searchParams.get("droppermissions") !== null) {
            args.push(true);
        }

        let requestUrlBase = location.origin + location.pathname;
        if (domainOrigin) {
            requestUrlBase = domainOrigin;
        }
        let requestUrl = requestUrlBase + `?classGuid=RequireController-e2f811f3-14b8-4759-b0d6-73f14516cf1d&functionName=getModules`;

        let remapImportRequestsClientside = globalThis.remapImportRequestsClientside;
        if (remapImportRequestsClientside) {
            for (let fnc of remapImportRequestsClientside) {
                args = await fnc(args);
            }
        }
        let rawText = await requestText(requestUrl, { args });
        let resultObj: {
            modules: { [id: string]: SerializedModule };
            requestsResolvedPaths: string[];
            requireSeqNumProcessId: string;
            error?: string;
        };
        try {
            resultObj = JSON.parse(rawText);
        } catch (e: any) {
            throw new Error(`require(${JSON.stringify(requests)}). Likely a permissions error, possibly fixed by restarting the local http server. Start of response was: ${JSON.stringify(rawText.slice(0, 100))}. Error is: ${e.stack}`);
        }
        let { modules, requestsResolvedPaths, requireSeqNumProcessId, error } = resultObj;

        if (error) {
            let errorObj = new Error();
            errorObj.stack = error;
            throw errorObj;
        }


        if (Object.keys(modules).length === 1 && "" in modules) {
            debugger;
            eval(modules[""].source || "");
            throw new Error(`Failed to find modules for ${originalRequests.join(", ")} (mapped to ${requests.join(", ")})`);
        }


        if (domainOrigin) {
            function fixDomain(request: string) {
                if (!request) return request;
                return domainOrigin + request;
            }
            requests = requests.map(fixDomain);
            for (let [id, module] of Object.entries(modules)) {
                delete modules[id];
                modules[fixDomain(id)] = module;
                module.filename = fixDomain(module.filename);
                module.requests = Object.fromEntries(Object.entries(module.requests).map(([k, v]) => [k, fixDomain(v)]));
                module.originalId = fixDomain(module.originalId);
            }
            requestsResolvedPaths = requestsResolvedPaths.map(fixDomain);
        }


        for (let i = 0; i < requests.length; i++) {
            rootResolveCache[requests[i]] = requestsResolvedPaths[i];
        }

        globalThis.onProgressHandler?.({
            type: "Compile",
            addValue: 0,
            addMax: Object.keys(modules).length,
        });

        // Store the function, so we only call it if it exists BEFORE we import
        //  (which means we already have something loading, so this is likely hot reloading...)
        let observerOnHotReload = g.observerOnHotReload;
        setTimeout(() => {
            if (observerOnHotReload) {
                observerOnHotReload();
            }
        }, 0);

        time = Date.now() - time;
        let moduleCount = Object.values(modules).filter((x) => x.source).length;
        let requireModuleCount = Object.values(modules).filter((x) => !x.source).length;
        let dependenciesOnlyText = requireModuleCount ? ` (+${requireModuleCount} dependencies only)` : "";
        console.log(
            `%cimport(${requests.join(", ")}) finished download ${time.toFixed(0)}ms, ${Math.ceil(
                rawText.length / 1024
            )}KB, ${moduleCount} modules${dependenciesOnlyText} at ${(Date.now() - startTime).toFixed(0)}ms`,
            "color: lightgreen"
        );



        if (alreadyHave?.requireSeqNumProcessId !== requireSeqNumProcessId) {
            alreadyHave = undefined;
        }
        alreadyHave = alreadyHave || { requireSeqNumProcessId, seqNums: {} };

        for (let id in modules) {
            let module = modules[id];
            alreadyHave.seqNums[module.seqNum] = 1;
            serializedModules[id] = module;
        }

        time = Date.now();
        let lastWaitTime = time;
        for (let key of Object.keys(modules)) {
            getModule(key, "preload");
            // Wait, so we can render progress (and in generals, so the UI remains somewhat responsive)
            if (Date.now() - lastWaitTime > 10) {
                await new Promise(resolve => setTimeout(resolve, 0));
                lastWaitTime = Date.now();
            }
        }

        time = Date.now() - time;
        console.log(
            `%cimport(${requests.join(", ")}) finished compile ${time.toFixed(0)}ms (${moduleCount} modules) at ${(Date.now() - startTime).toFixed(0)}ms`,
            "color: hotpink"
        );


        globalThis.onProgressHandler?.({
            type: "Evaluate",
            addValue: 0,
            addMax: Object.keys(modules).length,
        });

        time = Date.now();
        try {
            return requestsResolvedPaths.map((x) => getModule(x));
        } finally {
            time = Date.now() - time;
            console.log(
                `%cimport(${requests.join(", ")}) finished evaluate ${time.toFixed(0)}ms (${moduleCount} modules) at ${(Date.now() - startTime).toFixed(0)}ms`,
                "color: lightblue"
            );
        }
    }

    function createRequire(module: ModuleType, serializedModule: SerializedModule, asyncIsFineOuter?: boolean) {
        require.cache = moduleCache;
        // Dynamically get folder, incase our filename changes
        function getModuleFolder() {
            return module.filename.replace(/\\/g, "/").split("/").slice(0, -1).join("/") + "/";
        }
        function resolve(request: string) {
            let requests = serializedModule.requests;
            if (request in requests) {
                return requests[request];
            }
            let absolutePath = request;
            if (absolutePath.startsWith("./") || absolutePath.startsWith("../")) {
                let folderParts = getModuleFolder().split("/");
                while (absolutePath.startsWith("./") || absolutePath.startsWith("../")) {
                    if (absolutePath.startsWith("./")) {
                        absolutePath = absolutePath.slice("./".length);
                    } else {
                        folderParts.pop();
                        absolutePath = absolutePath.slice("../".length);
                    }
                }
                absolutePath = folderParts.join("/") + "/" + absolutePath;
            }
            // Still use the same domain
            if (!absolutePath.startsWith("https://")) {
                absolutePath = mainRootOrigin + absolutePath;
            }
            return absolutePath;
        }
        require.resolve = resolve;
        return require;
        function require(request: string, asyncIsFine?: boolean) {
            if (asyncIsFineOuter) {
                asyncIsFine = true;
            }
            if (typeof asyncIsFine !== "boolean") {
                asyncIsFine = false;
            }
            if (request in serializedModule.asyncRequests) {
                asyncIsFine = true;
            }
            if (request in builtInModuleExports) {
                return builtInModuleExports[request as keyof typeof builtInModuleExports];
            }

            let absolutePath = resolve(request);

            let resolvedPath: string | undefined;
            if (request in moduleCache) {
                resolvedPath = request;
            } else if (absolutePath in moduleCache) {
                resolvedPath = absolutePath;
            } else {
                if (!(request in serializedModule.requests)) {
                    if (!asyncIsFine && !globalThis.suppressUnexpectedModuleWarning) {
                        console.warn(
                            `Accessed unexpected module %c${request}%c in %c${module.id}%c\n\tTreating it as an async require.\n\tAll modules require synchronously clientside must be required serverside at a module level. Expected imports: ${Object.keys(serializedModule.requests).join(" | ")}`,
                            "color: red",
                            "color: unset",
                            "color: red",
                            "color: unset"
                        );
                    }
                    return rootRequire(absolutePath);
                }

                // Built in modules that we haven't been implemented
                if (serializedModule.requests[request] === "") {
                    return {};
                }

                resolvedPath = serializedModule.requests[request];
            }
            if (resolvedPath !== "NOTALLOWEDCLIENTSIDE" && !serializedModules[resolvedPath]) {
                if (!asyncIsFine) {
                    console.warn(
                        `Accessed unexpected module %c${request}%c in %c${module.id}%c\n\tTreating it as an async require.\n\tAll modules require synchronously clientside must be required serverside at a module level. Expected imports: ${Object.keys(serializedModule.requests).join(" | ")}`,
                        "color: red",
                        "color: unset",
                        "color: red",
                        "color: unset"
                    );
                }
                return rootRequire(resolvedPath);
            }

            let exportsOverride: unknown | undefined;
            if (resolvedPath === "NOTALLOWEDCLIENTSIDE" || !serializedModules[resolvedPath]?.allowclient) {
                let childId = resolvedPath === "NOTALLOWEDCLIENTSIDE" ? request : resolvedPath;
                if (serializedModules[resolvedPath]?.serveronly) {
                    exportsOverride = new Proxy(
                        {},
                        {
                            get(target, property) {
                                if (property === "__esModule") return undefined;
                                // NOTE: Return a toString that evaluates to "" so we can EXPLICITLY detect non-loaded modules
                                if (property === unloadedModule) return true;
                                if (property === "default") return exportsOverride;

                                throw new Error(
                                    `Module ${childId} is serverside only. Tried to access ${String(property)} from ${module.id}`
                                );
                            },
                        }
                    );
                } else {
                    exportsOverride = new Proxy(
                        {},
                        {
                            get(target, property) {
                                if (property === "__esModule") return undefined;
                                // NOTE: Return a toString that evaluates to "" so we can EXPLICITLY detect non-loaded modules
                                if (property === unloadedModule) return true;
                                if (property === "default") return exportsOverride;

                                let type = "non-whitelisted";
                                if (!serializedModules[resolvedPath!]) {
                                    type = "missing module";
                                }

                                console.warn(
                                    `Accessed ${type} module %c${childId}%c, specifically property %c${String(
                                        property
                                    )}%c.\n\tAdd %cmodule.allowclient = true%c to the file to allow access.\n\t(IF it is a 3rd party library, use the global "setFlag" helper (in the file you imported the module) to set properties on other modules (it can even recursively set properties)).\n\n\tFrom ${module.id
                                    }`,
                                    "color: red",
                                    "color: unset",
                                    "color: red",
                                    "color: unset",
                                    "color: red",
                                    "color: unset"
                                );
                                return undefined;
                            },
                        }
                    );
                }
            }

            if (resolvedPath === "NOTALLOWEDCLIENTSIDE") {
                return exportsOverride;
            }

            let providerModule = getModule(resolvedPath);
            module.children.push(providerModule);
            if (exportsOverride !== undefined) {
                providerModule.exports = exportsOverride;
            }

            let exports = providerModule.exports;
            let remapExports = providerModule.remapExports;
            if (remapExports && typeof remapExports === "function") {
                exports = remapExports(exports, module);
            }

            return exports;
        }
    }

    /** Generates the module root function, which can be called to evaluate the module,
     *      and has code equal to contents.
     *      - filename is just for debugging / stack traces
     */
    function wrapSafe(filename: string, contents: string) {
        // TODO: Have the serverside inform us of the correct loader, or... have it actually emit a .json loader.
        if (filename.endsWith(".json")) {
            return (exports: unknown, require: unknown, module: ModuleType) => (module.exports = contents && JSON.parse(contents));
        }

        // NOTE: debugName only matters during module evaluation. After that the sourcemap should work.
        let debugName = filename
            .replace(/\\/g, "/")
            .split("/")
            .slice(-1)[0]
            .replace(/\./g, "_")
            .replace(/[^a-zA-Z_]/g, "");
        // NOTE: eval is used instead of new Function, as new Function inject lines, which messes
        //  up our sourcemaps.
        // NOTE: All on one line, so we don't break sourcemaps by TOO much. We could also parse
        //  the sourcemap and adjust it, but... it is much easier to just not change the line counts.
        return eval(
            `(function ${debugName}(exports, require, module, __filename, __dirname, importDynamic) {${contents}\n })`
        );
    }

    const unloadedModule = Symbol("unloadedModule");

    let currentModuleEvaluationStack: string[] = [];
    // See https://nodejs.org/api/modules.html
    function getModule(resolvedId: string, preload?: "preload"): ModuleType {
        if (resolvedId === "") {
            return {} as ModuleType;
        }
        if (resolvedId in moduleCache) {
            let module = moduleCache[resolvedId];
            if (!preload && !module.loaded) {
                module.loaded = true;
                module.load();
            }
            return module;
        }

        let serializedModule = serializedModules[resolvedId];
        if (!serializedModule) {
            // I can't figure out why this happens as it seems to happen very rarely and only when I'm debugging other code.
            //  - I have had it happen immediately after starting the app. Although in theory a hot reload could have
            //      triggered due to VS code writing to a file. 
            //  - I've had times when it happens once after startup and then it goes away and other times where it
            //      happens every single time and never goes away until I restart aipaint.
            //  - Maybe it happens if we switch servers and so the root paths are different in some way?
            debugger;
            console.warn(`Failed to find module ${resolvedId}. The server should have given an error about this.`, serializedModules);
        }

        let module = Object.create(null) as ModuleType;
        moduleCache[resolvedId] = module;
        module.id = resolvedId;
        module.filename = serializedModule?.filename || "";
        module.exports = {};
        // Default default of exports to the exports itself
        (module.exports as any).default = module.exports;
        module.children = [];
        for (let key in serializedModule?.flags || {}) {
            if (key === "loaded") continue;
            (module as any)[key] = true;
        }

        module.load = load;

        let originalSource = serializedModule?.source || "";
        let moduleFnc = wrapSafe(module.id, originalSource);

        globalThis.onProgressHandler?.({
            type: "Compile",
            addValue: 1,
            addMax: 0,
        });

        if (!preload) {
            module.loaded = true;
            module.load();
        }

        function load() {
            const serializedModule = serializedModules[resolvedId];
            if (!serializedModule) return;
            if (!module.loaded) {
                module.evaluateStarted = false;
                if (alreadyHave) {
                    delete alreadyHave.seqNums[serializedModule.seqNum];
                }
                // NOTE: There is almost never a way to recover from module downloading errors, so just don't catch them
                return Promise.resolve()
                    .then(() => rootRequire(resolvedId, true))
                    .then(async () => {
                        module.loaded = true;
                        await load();
                    });
            }

            // Skip double loads
            if (module.evaluateStarted) return;

            module.original = serializedModule;

            module.requires = serializedModule.requests;
            module.require = createRequire(module, serializedModule) as any;
            // TODO: Once typescript supports dynamic import, map import() to importDynamic, so it
            //  uses our import function, instead of the built in one.
            //  (As apparently we can't just override import on a per module basis, because
            //      we can't have an identify called "import"... which is annoying).
            let importDynamic = createRequire(module, serializedModule, true);
            module.import = importDynamic;

            let source = serializedModule.source;

            module.allowclient = !!serializedModule.source;

            // Import children, as the children may be allowed clientside, and may have side-effects!
            if (!source) {
                let requests = Object.keys(serializedModule.requests)
                    .filter((x) => x !== "NOTALLOWEDCLIENTSIDE")
                    .filter((x) => !(x in serializedModule.asyncRequests));
                source = requests.map((id) => `require(${JSON.stringify(id)});\n`).join("");
            }

            module.size = source.length;
            module.source = source;

            if (source !== originalSource) {
                originalSource = source;
                moduleFnc = wrapSafe(module.id, originalSource);
            }

            let dirname = module.filename.replace(/\\/g, "/").split("/").slice(0, -1).join("/");

            let time = Date.now();
            currentModuleEvaluationStack.push(module.filename);
            try {
                module.evaluateStarted = true;
                module.isPreloading = true;
                module.evalStartTime = nextTime();
                module.evalEndTime = undefined;
                moduleFnc.call(
                    {
                        // NOTE: Adding __importStar to the module causes typescript to use our implementation,
                        //  which checks for unloadedModule and returns undefined in that case.
                        __importStar(mod: any) {
                            if (mod[unloadedModule]) return undefined;
                            return mod;
                        },
                        __importDefault(mod: any) {
                            return mod.default ? mod : { default: mod };
                        },
                    },
                    module.exports,
                    // eslint-disable-next-line @typescript-eslint/unbound-method
                    module.require,
                    module,
                    module.filename,
                    dirname,
                    importDynamic
                );
                module.evalEndTime = nextTime();
                time = Date.now() - time;
                // NOTE: This log statment is disabled as I believe it causes lag (when devtools is open).
                //  As in, adding about 500ms to our load time, which is annoying when debugging.
                //console.debug(`Evaluated module ${module.filename} ${Math.ceil(source.length / 1024)}KB`);
            } finally {
                module.isPreloading = false;
                currentModuleEvaluationStack.pop();

                globalThis.onProgressHandler?.({
                    type: "Evaluate",
                    addValue: 1,
                    addMax: 0,
                });
            }
        }

        return module;
    }
}