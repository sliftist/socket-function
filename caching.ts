export function lazy<T>(factory: () => T): () => T {
    let value: { value: T }|undefined = undefined;

    return () => {
        if(!value) {
            value = { value: factory() };
        }
        return value.value;
    };
}