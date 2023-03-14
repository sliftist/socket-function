(function () {
    // Globals
    Object.assign(window, {
        process: {
            argv: [],
            env: {
                // Mirror the tnode.js setting
                NODE_ENV: "production"
            },
        },
        setImmediate(callback) {
            setTimeout(callback, 0);
        },
        // Ignore flags for now, even though they should work fine if we just hardcoded compileFlags.ts here.
        setFlag() { },
        global: window,
    });

    // Not real modules, as we just define their exports
    const builtInModuleExports = {
        worker_threads: {
            isMainThread: true
        },
        util: {
            // https://nodejs.org/api/util.html#util_util_inherits_constructor_superconstructor
            inherits(constructor, superConstructor) {
                Object.setPrototypeOf(constructor.prototype, superConstructor.prototype);
            }
        },
        buffer: { Buffer },
        stream: {
            // HACK: Needed to get SAX JS to work correctly.
            Stream: function () { },
        },
        timers: {
            // TODO: Add all members of timers
            setImmediate: window.setImmediate,
        },
        child_process: {},
        events: {},
    };
    global.builtInModuleExports = builtInModuleExports;


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
            // NOTE: IF !allowclient && !serveronly, it might just mean we didn't add allowclient
            //  to the module yet. BUT, if serveronly, then we know for sure we don't want it client.
            //  So the messages and behavior will be different.
            allowclient?: boolean;
            serveronly?: boolean;
    
            source?: string;
        }
    }} */
    let serializedModules = Object.create(null);

    let moduleCache = Object.create(null);
    let alreadyHave = undefined;

    let rootResolveCache = Object.create(null);

    rootRequire.cache = moduleCache;
    // Expose require for debugging, not so it can be called
    window.require = rootRequire;
    window.import = rootRequire;

    window.r = function r(text) {
        text = text.toLowerCase();
        return Object
            .values(moduleCache)
            .filter(x => x.filename.toLowerCase().includes(text))
        [0]
            .exports;
    };

    let requireBatch;
    function rootRequire(request, batch) {
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
            return builtInModuleExports[request];
        }
        if (batch) {
            if (!requireBatch) {
                requireBatch = requireBatch || {};
                setTimeout(() => {
                    let requests = Object.keys(requireBatch);
                    let callbacks = Object.values(requireBatch).reduce((a, b) => a.concat(b), []);
                    requireBatch = undefined;
                    void rootRequireMultiple(requests, true).then(() => {
                        for (let callback of callbacks) {
                            callback();
                        }
                    }, err => { throw err; });
                }, 0);
            }
            return new Promise(resolve => {
                requireBatch[request] = requireBatch[request] || [];
                requireBatch[request].push(resolve);
            });
        } else {
            return rootRequireMultiple([request]).then(x => x[0].exports);
        }
    }
    async function rootRequireMultiple(requests) {
        console.log(`%cimport(${requests.join(", ")})`, "color: orange");

        let time = Date.now();

        let alreadyHaveRanges;
        if (alreadyHave) {
            let seqNums = Object.keys(alreadyHave.seqNums).map(x => +x);
            seqNums.sort((a, b) => a - b);
            let seqNumRanges = [];
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

        let args = [requests, alreadyHaveRanges];
        // We have to add hardcoded support for droppermissions, because... this call
        //  doesn't have the conventional persisted code sending code, because... it's
        //  all on its own.
        if (new URL(location).searchParams.get("droppermissions") !== null) {
            args.push(true);
        }
        let requestUrl = location.origin + location.pathname + `?classGuid=RequireController-e2f811f3-14b8-4759-b0d6-73f14516cf1d&functionName=getModules`;
        let rawText = await requestText(requestUrl, { args });
        let resultObj;
        try {
            resultObj = JSON.parse(rawText);
        } catch (e) {
            console.log(rawText);
            throw e;
        }
        let { modules, requestsResolvedPaths, requireSeqNumProcessId, error } = resultObj;

        if (error) {
            let errorObj = new Error();
            errorObj.stack = error;
            throw errorObj;
        }

        for (let i = 0; i < requests.length; i++) {
            rootResolveCache[requests[i]] = requestsResolvedPaths[i];
        }

        // Store the function, so we only call it if it exists BEFORE we import
        //  (which means we already have something loading, so this is likely hot reloading...)
        let observerOnHotReload = global.observerOnHotReload;
        setTimeout(() => {
            if (observerOnHotReload) {
                observerOnHotReload();
            }
        }, 0);

        time = Date.now() - time;
        let moduleCount = Object.values(modules).filter(x => x.source).length;
        let requireModuleCount = Object.values(modules).filter(x => !x.source).length;
        let dependenciesOnlyText = requireModuleCount ? ` (+${requireModuleCount} dependencies only)` : "";
        console.log(`%cimport(${requests.join(", ")}) download ${time}ms, ${Math.ceil(rawText.length / 1024)}KB, ${moduleCount} modules${dependenciesOnlyText}`, "color: green");

        time = Date.now();

        if (alreadyHave?.requireSeqNumProcessId !== requireSeqNumProcessId) {
            alreadyHave = { requireSeqNumProcessId, seqNums: {} };
        }

        for (let id in modules) {
            let module = modules[id];
            alreadyHave.seqNums[module.seqNum] = 1;
            serializedModules[id] = module;
        }

        try {
            return requestsResolvedPaths.map(x => getModule(x));
        } finally {
            time = Date.now() - time;
            console.log(`%cimport(${requests.join(", ")}) evaluate ${time}ms (${moduleCount} modules)`, "color: blue");
        }
    }

    function createRequire(module, serializedModule, asyncIsFine) {
        require.cache = moduleCache;
        require.resolve = function (request) {
            // TODO: Maybe do a request, making this async, if it isn't found?
            return serializedModule.requests[request];
        };
        return require;
        function require(request) {
            if (request in builtInModuleExports) {
                return builtInModuleExports[request];
            }

            if (!(request in serializedModule.requests)) {
                if (!asyncIsFine) {
                    console.warn(`Accessed unexpected module %c${request}%c in %c${module.id}%c\n\tTreating it as an async require.\n\tAll modules require synchronously clientside must be required serverside at a module level.`,
                        "color: red", "color: unset",
                        "color: red", "color: unset",
                    );
                }
                debugger;
                return rootRequire(request);
            }

            // Built in modules that we haven't been implemented
            if (serializedModule.requests[request] === "") {
                return {};
            }

            let resolvedPath = serializedModule.requests[request];
            if (resolvedPath !== "NOTALLOWEDCLIENTSIDE" && !serializedModules[resolvedPath]) {
                if (!asyncIsFine) {
                    console.warn(`Accessed unexpected module %c${request}%c in %c${module.id}%c\n\tTreating it as an async require.\n\tAll modules require synchronously clientside must be required serverside at a module level.`,
                        "color: red", "color: unset",
                        "color: red", "color: unset",
                    );
                }
                return rootRequire(resolvedPath);
            }

            let exportsOverride = undefined;
            if (resolvedPath === "NOTALLOWEDCLIENTSIDE" || !serializedModules[resolvedPath].allowclient) {
                let childId = resolvedPath === "NOTALLOWEDCLIENTSIDE" ? request : resolvedPath;
                if (serializedModules[resolvedPath]?.serveronly) {
                    exportsOverride = new Proxy({}, {
                        get(target, property) {
                            if (property === "__esModule") return undefined;
                            // NOTE: Return a toString that evaluates to "" so we can EXPLICITLY detect non-loaded modules
                            if (property === unloadedModule) return true;
                            if (property === "default") return exportsOverride;

                            throw new Error(`Module ${childId} is serverside only. Tried to access ${property} from ${module.id}`);
                        }
                    });
                } else {
                    exportsOverride = new Proxy({}, {
                        get(target, property) {
                            if (property === "__esModule") return undefined;
                            // NOTE: Return a toString that evaluates to "" so we can EXPLICITLY detect non-loaded modules
                            if (property === unloadedModule) return true;
                            if (property === "default") return exportsOverride;

                            serializedModule;

                            console.warn(`Accessed non-whitelisted module %c${childId}%c, specifically property %c${String(property)}%c.\n\tAdd %cmodule.allowclient = true%c to the file to allow access.\n\t(IF it is a 3rd party library, use the global "setFlag" helper (in the file you imported the module) to set properties on other modules (it can even recursively set properties)).\n\n\tFrom ${module.id}`,
                                "color: red", "color: unset",
                                "color: red", "color: unset",
                                "color: red", "color: unset",
                            );
                            return undefined;
                        }
                    });
                }
            }

            if (resolvedPath === "NOTALLOWEDCLIENTSIDE") {
                return exportsOverride;
            }

            let childModule = getModule(resolvedPath);
            module.children.push(childModule);
            if (exportsOverride !== undefined) {
                childModule.exports = exportsOverride;
            }
            return childModule.exports;
        };
    }

    /** Generates the module root function, which can be called to evaluate the module,
     *      and has code equal to contents.
     *      - filename is just for debugging / stack traces
     */
    function wrapSafe(filename, contents) {
        // TODO: Have the serverside inform us of the correct loader, or... have it actually emit a .json loader.
        if (filename.endsWith(".json")) {
            return (exports, require, module) => module.exports = contents && JSON.parse(contents);
        }

        // NOTE: debugName only matters during module evaluation. After that the sourcemap should work.
        let debugName = (
            filename
                .replace(/\\/g, "/")
                .split("/")
                .slice(-1)[0]
                .replace(/\./g, "_")
                .replace(/[^a-zA-Z_]/g, "")
        );
        // NOTE: eval is used instead of new Function, as new Function inject lines, which messes
        //  up our sourcemaps.
        // NOTE: All on one line, so we don't break sourcemaps by TOO much. We could also parse
        //  the sourcemap and adjust it, but... it is much easier to just not change the line counts.
        return eval(`(function ${debugName}(exports, require, module, __filename, __dirname, importDynamic) {${contents}\n })`);
    }


    const unloadedModule = Symbol("unloadedModule");

    let currentModuleEvaluationStack = [];
    // See https://nodejs.org/api/modules.html
    function getModule(resolvedId) {
        if (resolvedId === "") {
            return {};
        }
        if (resolvedId in moduleCache) {
            return moduleCache[resolvedId];
        }

        let serializedModule = serializedModules[resolvedId];

        let module = Object.create(null);
        moduleCache[resolvedId] = module;
        module.id = resolvedId;
        module.filename = serializedModule?.filename;
        module.exports = {};
        module.exports.default = module.exports;
        module.children = [];

        module.load = load;

        module.loaded = true;
        module.load();

        function load(filename) {
            let serializedModule = serializedModules[resolvedId];
            if (!module.loaded) {
                if (alreadyHave) {
                    delete alreadyHave.seqNums[serializedModule.seqNum];
                }
                // NOTE: There is almost never recovery from module downloading errors, so just don't catch them
                void Promise.resolve().then(() => rootRequire(resolvedId, true)).then(() => {
                    module.loaded = true;
                    load();
                });
                return;
            }

            module.requires = serializedModule.requests;
            module.require = createRequire(module, serializedModule);
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
                let requests = Object.keys(serializedModule.requests).filter(x => x !== "NOTALLOWEDCLIENTSIDE");
                source = requests.map(id => `require(${JSON.stringify(id)});\n`).join("");
            }

            module.size = source.length;

            let moduleFnc = wrapSafe(module.id, source);

            let dirname = module.filename.replace(/\\/g, "/").split("/").slice(0, -1).join("/");

            let time = Date.now();
            currentModuleEvaluationStack.push(module.filename);
            try {
                moduleFnc.call(
                    {
                        // NOTE: Adding __importStar to the module causes typescript to use our implementation,
                        //  which checks for unloadedModule and returns undefined in that case.
                        __importStar(mod) {
                            if (mod[unloadedModule]) return undefined;
                            return mod;
                        },
                        __importDefault(mod) {
                            return mod.default ? mod : { default: mod };
                        },
                    },
                    module.exports,
                    module.require,
                    module,
                    module.filename,
                    dirname,
                    importDynamic
                );
                time = Date.now() - time;
                // NOTE: This log statment is disabled as I believe it causes lag (when devtools is open).
                //  As in, adding about 500ms to our load time, which is annoying when debugging.
                //console.debug(`Evaluated module ${module.filename} ${Math.ceil(source.length / 1024)}KB`);
            } finally {
                currentModuleEvaluationStack.pop();
            }

        }

        return module;
    }

    async function requestText(endpoint, values) {
        let url = new URL(endpoint);

        let json = JSON.stringify(values);
        if (json.length < 6000) {
            // NOTE: Try to use a GET, as GETs can be cached! However, if the data is too large,
            //  we have to use a post, or else the request url will be too large
            for (let key in values) {
                url.searchParams.set(key, JSON.stringify(values[key]));
            }
            let response = await fetch(url.toString(), {
                method: "GET",
                credentials: "include",
            });
            return await response.text();
        } else {
            let response = await fetch(url.toString(), {
                method: "POST",
                body: json,
                credentials: "include",
            });
            return await response.text();
        }
    }
})();