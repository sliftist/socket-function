const arrayIsSplitable = Symbol.for("arrayIsSplitable");
export function markArrayAsSplitable<T>(data: T[]): T[] {
    (data as any)[arrayIsSplitable] = true;
    return data;
}
export function isSplitableArray<T>(data: T): data is T & (unknown[]) {
    if (!Array.isArray(data)) return false;
    return !!(data as any)[arrayIsSplitable];
}