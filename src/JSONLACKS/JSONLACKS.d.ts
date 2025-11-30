/// <reference types="node" />
/// <reference types="node" />
export interface JSONLACKS_ParseConfig {
    extended?: boolean;
    discardMissingReferences?: boolean;
}
export interface JSONLACKS_StringifyConfig {
    allowObjectMutation?: boolean;
}
interface HydrateState {
    references: Map<string, unknown>;
    visited: Set<unknown>;
}
export declare class JSONLACKS {
    static readonly LACKS_KEY = "__JSONLACKS__98cfb4a05fa34d828661cae15b8779ce__";
    /** If set to true parses non-quoted field names, comments, trailing commas, etc */
    static EXTENDED_PARSER: boolean;
    static IGNORE_MISSING_REFERENCES: boolean;
    static stringify(obj: unknown, config?: JSONLACKS_StringifyConfig): string;
    /** Is useful when serializing an array to a file with one object per line */
    static stringifyFile(obj: unknown[], config?: JSONLACKS_StringifyConfig): Promise<Buffer>;
    static stringifyFileSync(obj: unknown[], config?: JSONLACKS_StringifyConfig): Buffer;
    static parse<T>(text: string, config?: JSONLACKS_ParseConfig, hydrateState?: HydrateState): T;
    static parseLines<T>(buffer: Buffer, config?: JSONLACKS_ParseConfig): Promise<T[]>;
    private static escapeSpecialObjects;
    private static hydrateSpecialObjects;
}
export {};
