
import { enableMeasurements, measureBlock, measureCode, measureCodeSync, measureFnc } from "../profiling/measure";
// enableMeasurements();

import debugbreak from "debugbreak";
import fs from "fs";

import parser from "./JSONLACKS.generated.js";
import { recursiveFreeze } from "../misc";
import { canHaveChildren } from "../types";
import { delay } from "../batching";

const SERIALIZE_OBJECT_BATCH_COUNT = 1000;
const PARSE_BYTE_CHUNK_SIZE = 1024 * 1024 * 10;

export interface JSONLACKS_ParseConfig {
    // Defaults to true. Enables parsing of:
    //  - Trailing commas
    //  - Non-quoted field names (ex, "{ x: 1 }")
    //  - Comments (strips them, but doesn't throw)
    extended?: boolean;
    discardMissingReferences?: boolean;
}
export interface JSONLACKS_StringifyConfig {
    // If specified, we are allowed to mutate the provided object. Speeds up serialization.
    allowObjectMutation?: boolean;
}

interface HydrateState {
    references: Map<string, unknown>,
    visited: Set<unknown>,
}

// Supports json and also:
//  - Non quoted field names "{ x: 1 }"?
//  - Trailing commas
//      NOTE: Comma only syntax is not supported, ex, "[,,]", which is an array of length 2 in javascript
//  - Comments on input, but not on output
//  - References
//  - Buffers (just Buffers, not typed arrays)
// The stringify function always creates valid json, as the syntax for references and buffers
//  will just be special property names and values.
// NOTE: We don't support Date serialization. Never store Dates, store "number".
export class JSONLACKS {
    public static readonly LACKS_KEY = "__JSONLACKS__98cfb4a05fa34d828661cae15b8779ce__";

    /** If set to true parses non-quoted field names, comments, trailing commas, etc */
    public static EXTENDED_PARSER = false;
    public static IGNORE_MISSING_REFERENCES = false;

    @measureFnc
    public static stringify(obj: unknown, config?: JSONLACKS_StringifyConfig): string {
        let serialized = JSONLACKS.escapeSpecialObjects(obj, config);
        return measureBlock(function JSONstringify() { return JSON.stringify(serialized); });
    }
    /** Is useful when serializing an array to a file with one object per line */
    @measureFnc
    public static async stringifyFile(obj: unknown[], config?: JSONLACKS_StringifyConfig): Promise<Buffer> {
        let serialized = JSONLACKS.escapeSpecialObjects(obj, config) as unknown[];
        return await measureBlock(async function JSONstringifyAndJoin() {
            let buffers: Buffer[] = [];
            for (let i = 0; i < serialized.length; i += SERIALIZE_OBJECT_BATCH_COUNT) {
                let str = serialized.slice(i, i + SERIALIZE_OBJECT_BATCH_COUNT).map(x => JSON.stringify(x) + "\n").join("");
                buffers.push(Buffer.from(str));
                await delay("immediate");
            }
            // Break up into chunks, as string => Buffer i
            return Buffer.concat(buffers);
        });
    }
    public static stringifyFileSync(obj: unknown[], config?: JSONLACKS_StringifyConfig): Buffer {
        let serialized = JSONLACKS.escapeSpecialObjects(obj, config) as unknown[];
        return measureBlock(function JSONstringifyAndJoin() {
            let buffers: Buffer[] = [];
            for (let i = 0; i < serialized.length; i += SERIALIZE_OBJECT_BATCH_COUNT) {
                let str = serialized.slice(i, i + SERIALIZE_OBJECT_BATCH_COUNT).map(x => JSON.stringify(x) + "\n").join("");
                buffers.push(Buffer.from(str));
            }
            // Break up into chunks, as string => Buffer i
            return Buffer.concat(buffers);
        });
    }
    // TIMING: Seems to be about 40X slower than JSON.parse unless extended is set to false,
    //  then it is about 2X slower (although it depends on the size and complexity of the objects!)
    @measureFnc
    public static parse<T>(text: string, config?: JSONLACKS_ParseConfig, hydrateState?: HydrateState): T {
        let obj: unknown;

        let extendedParsing = config?.extended ?? JSONLACKS.EXTENDED_PARSER;

        if (extendedParsing) {
            obj = measureBlock(function JSONextendedParse() { return parser.parse(text); });
        } else {
            try {
                obj = measureBlock(function JSONparse() { return JSON.parse(text); });
            } catch {
                obj = measureBlock(function JSONextendedParse() { return parser.parse(text); });
            }
        }

        return JSONLACKS.hydrateSpecialObjects(obj, hydrateState, config) as T;
    }
    @measureFnc
    public static async parseLines<T>(buffer: Buffer, config?: JSONLACKS_ParseConfig): Promise<T[]> {
        let output: T[] = [];
        let pos = 0;
        let hydrateState: HydrateState = {
            references: new Map(),
            visited: new Set(),
        };
        function parseChunk() {
            let start = pos;
            let lastNewLine = 0;
            while (pos < buffer.length && (!lastNewLine || (pos - start) < PARSE_BYTE_CHUNK_SIZE)) {
                let byte = buffer[pos];
                if (byte === 10) {
                    lastNewLine = pos;
                }
                pos++;
            }
            if (pos === buffer.length) {
                lastNewLine = pos;
            }
            pos = lastNewLine + 1;

            let text = buffer.slice(start, lastNewLine).toString("utf8");
            let lines = text
                .replaceAll("\r", "")
                .split("\n")
                .filter(x => x && !x.startsWith("//"))
                ;
            let linesJSON = "[";
            for (let i = 0; i < lines.length; i++) {
                if (i !== 0) linesJSON += ",";
                linesJSON += lines[i];
            }
            linesJSON += "]";
            if (config?.discardMissingReferences) {
                try {
                    let parts = JSONLACKS.parse(linesJSON, config, hydrateState) as T[];
                    for (let part of parts) {
                        output.push(part);
                    }
                } catch (e: any) {
                    if (!e.message.includes("Reference to undefined id")) {
                        throw e;
                    }
                    for (let line of lines) {
                        try {
                            let part = JSONLACKS.parse(line, config, hydrateState) as T;
                            output.push(part);
                        } catch (e: any) {
                            if (!e.message.includes("Reference to undefined id")) {
                                throw e;
                            }
                        }
                    }
                }
            } else {
                let parts = JSONLACKS.parse(linesJSON, config, hydrateState) as T[];
                for (let part of parts) {
                    output.push(part);
                }
            }
        }
        while (pos < buffer.length) {
            parseChunk();
            // Wait, to allow other thread to do work. We wait a long time... because we parse 10MB at once,
            //  so... this gives us 2s of delay per 1GB of parsing, which should only be a fraction of our parse time
            if (pos < buffer.length) {
                await delay(20);
            }
        }
        return output;
    }

    @measureFnc
    private static escapeSpecialObjects(obj: unknown, config?: JSONLACKS_StringifyConfig): unknown {
        // I think iterating twice for references is the fastest way to do it?
        let objects = new Set<unknown>();
        // NOTE: Use unique values for references, to allow concatenating files without having to
        //  deal with escaping references.
        let refPrefix = Date.now() + Math.random() + "";
        let nextRefId = 0;
        function getNextRefKey() {
            return refPrefix + "_" + nextRefId++;
        }
        let refObjects = new Map<unknown, string>();
        findReferences(obj);
        function findReferences(obj: unknown) {
            if (!canHaveChildren(obj)) return;
            if (refObjects.has(obj)) return;
            if (objects.has(obj)) {
                let refKey = getNextRefKey();
                refObjects.set(obj, refKey);
                return;
            }
            objects.add(obj);
            for (let key in obj) {
                findReferences(obj[key]);
            }
        }

        let refsSeen = new Set<unknown>();
        return iterate(obj);
        function iterate(obj: unknown, refHandled?: boolean): unknown {
            if (!canHaveChildren(obj)) return obj;
            if (!refHandled) {
                let refKey = refObjects.get(obj);
                if (refKey) {
                    if (refsSeen.has(obj)) {
                        return {
                            [JSONLACKS.LACKS_KEY]: "ref",
                            id: refKey,
                        };
                    }
                    refsSeen.add(obj);
                    return {
                        [JSONLACKS.LACKS_KEY]: "define",
                        id: refKey,
                        value: iterate(obj, true),
                    };
                }
            }

            if (JSONLACKS.LACKS_KEY in obj) {
                let restOfObj = { ...obj };
                let escapedValue = restOfObj[JSONLACKS.LACKS_KEY];
                delete restOfObj[JSONLACKS.LACKS_KEY];
                return {
                    [JSONLACKS.LACKS_KEY]: "removedSpecialKey",
                    escapedValue: iterate(escapedValue),
                    restOfObj: iterate(restOfObj),
                };
            }

            if (obj instanceof Buffer) {
                return {
                    [JSONLACKS.LACKS_KEY]: "Buffer",
                    data: obj.toString("base64"),
                };
            }

            let cloned = config?.allowObjectMutation;
            function cloneObj() {
                if (cloned) return;
                cloned = true;
                if (Array.isArray(obj)) {
                    obj = [...obj];
                } else {
                    obj = { ...obj as any };
                }
            };
            for (let key in obj) {
                let originalValue = obj[key];
                let value = iterate(originalValue);
                if (value !== originalValue) {
                    cloneObj();
                    obj[key] = value;
                }
            }
            return obj;
        }
    }

    @measureFnc
    private static hydrateSpecialObjects(obj: unknown, hydrateState?: HydrateState, config?: JSONLACKS_ParseConfig): unknown {
        let references = hydrateState?.references || new Map<string, unknown>();
        let visited = hydrateState?.visited || new Set<unknown>();
        return iterate(obj);
        function iterate(obj: unknown) {
            if (!canHaveChildren(obj)) return obj;
            if (visited.has(obj)) return obj;
            visited.add(obj);
            let type = obj[JSONLACKS.LACKS_KEY];
            if (!type) {
                for (let key in obj) {
                    let originalValue = obj[key];
                    let value = iterate(originalValue);
                    if (value !== originalValue) {
                        obj[key] = value;
                    }
                }
                return obj;
            }
            if (type === "removedSpecialKey") {
                let restOfObj = iterate(obj.restOfObj) as any;
                let escapedValue = iterate(obj.escapedValue) as any;
                return { ...restOfObj, [JSONLACKS.LACKS_KEY]: escapedValue };
            }
            if (type === "Buffer") {
                return Buffer.from(obj.data as string, "base64");
            }
            if (type === "define") {
                references.set(obj.id as string, iterate(obj.value));
                return obj.value;
            }
            if (type === "ref") {
                let id = obj.id as string;
                if (!JSONLACKS.IGNORE_MISSING_REFERENCES && !references.has(id)) {
                    if (!config?.discardMissingReferences) {
                        debugbreak(2);
                        debugger;
                    }
                    throw new Error(`Reference to undefined id "${id}"`);
                }
                return references.get(id);
            }
            throw new Error(`Unknown lacks type "${type}"`);
        }
    }
}

async function benchmark() {
    const loops = 1000 * 100;
    let inputs: string[] = [];
    for (let i = 0; i < loops; i++) {
        inputs.push(JSON.stringify({
            i,
            hello_there: i,
            example: 5,
            list: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        }) + " ");
    }
    JSON.parse(inputs[0]);
    parser.parse(inputs[0]);

    measureCodeSync(function measure() {
        measureBlock(function JSON_PARSE() {
            for (let i = 0; i < loops; i++) {
                JSON.parse(inputs[i]);
            }
        });
        measureBlock(function JSON_PARSE_FREEZE() {
            for (let i = 0; i < loops; i++) {
                let obj = JSON.parse(inputs[i]);
                recursiveFreeze(obj);
            }
        });

        measureBlock(function EXTENDED_PARSE() {
            for (let i = 0; i < loops; i++) {
                parser.parse(inputs[i]);
            }
        });

        measureBlock(function JSONLACKS_PARSE() {
            for (let i = 0; i < loops; i++) {
                JSONLACKS.parse(inputs[i]);
            }
        });
        measureBlock(function JSONLACKS_PARSE_SIMPLE() {
            for (let i = 0; i < loops; i++) {
                JSONLACKS.parse(inputs[i], { extended: false });
            }
        });

    }, {
        thresholdInTable: 0
    });

}
//benchmark().catch(console.error).finally(() => process.exit());


async function testJSONLACKS() {
    {
        let obj = {};
        let str = JSONLACKS.stringify({
            a: obj,
            b: obj,
        });
        let parsed = JSONLACKS.parse(str) as any;
        if (parsed.a !== parsed.b) {
            throw new Error("Failed to maintain references");
        }
        if (typeof parsed.a !== "object") {
            throw new Error("Object become corrupted");
        }
    }

    // Test LACKS_KEY is escaped correctly
    {
        let obj = { [JSONLACKS.LACKS_KEY]: "hello" };
        let str = JSONLACKS.stringify(obj);
        let parsed = JSONLACKS.parse(str) as any;
        if (JSON.stringify(obj) !== JSON.stringify(parsed)) {
            throw new Error("Failed to escape LACKS_KEY");
        }
    }
    // Test buffers are preserved
    {
        let obj = { a: Buffer.from("hello") };
        let str = JSONLACKS.stringify(obj);
        let parsed = JSONLACKS.parse(str) as any;
        if (obj.a.toString() !== parsed.a.toString()) {
            throw new Error(`Failed to preserve buffers`);
        }
    }

    // Test references 2
    {
        let base = {};
        let arr = [base, base];
        let obj = { x: arr, y: arr };
        let result = JSONLACKS.parse(JSONLACKS.stringify(obj), { extended: false }) as typeof obj;
        if (JSON.stringify(result) !== JSON.stringify(obj)) {
            throw new Error(`Corrupted values, expected ${JSON.stringify(obj)}, got ${JSON.stringify(result)}`);
        }
        if (result.x !== result.y) {
            throw new Error(`Failed to maintain references`);
        }
        if (result.x[0] !== result.x[1]) {
            throw new Error(`Failed to maintain references`);
        }
    }
}
//testJSONLACKS().catch(console.error).finally(() => process.exit());

async function generateAndVerifyParser() {
    const pegjs = await import("pegjs");

    var grammar = fs.readFileSync(__dirname + "/JSONLACKS.pegjs", "utf8");
    var parserSource = pegjs.generate(grammar, { output: "source", format: "commonjs" });
    fs.writeFileSync(__dirname + "/JSONLACKS.generated.js", parserSource);

    var module = { exports: {} };
    eval(parserSource);
    const parser = module.exports as any;
    function verify(text: string) {
        var parsed = parser.parse(text);
        var result = JSON.stringify(parsed);
        let realResult = JSON.stringify(eval("(" + text + ")"));
        if (result !== realResult) {
            throw new Error(`Failed to parse: ${text} should be ${realResult}, was ${result}`);
        }
    }

    verify(`
    {
        "hello_there": 1,
    }
    `);
    verify(`
    {
        hello_there: 1,
    }
    `);
    verify(`
    {
        hello_there: 1,
        more: 1,
    }
    `);
    verify(`{ list: [1,], }`);
    verify(`{ list: [1,], list2: [1,], }`);

    verify(`{ /* test */ list: [1,], list2: [1,], }`);
    verify(`{ /* test */ /* test 2 */ list: [1,], list2: [1,], }`);
    verify(`
    {
        /* test */
        /* test 2 */
        list: [1,],
        // Single line comment
        list2: [1,],
        // list3: [3],
    }
    `);
}
//generateAndVerifyParser().catch(console.error).finally(() => process.exit());