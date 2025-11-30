export type HSL = {
    h: number;
    s: number;
    l: number;
};
export declare function hslText(color: HSL): string;
export declare function hslToRGB(color: HSL): {
    r: number;
    g: number;
    b: number;
};
export declare function hslToHex(color: HSL): string;
export declare function hslLightenGamma(hsl: HSL, fraction: number): {
    h: number;
    s: number;
    l: number;
};
export declare function hslLightenLinear(hsl: HSL, lightness: number): {
    h: number;
    s: number;
    l: number;
};
export declare function hslDarkenGamma(hsl: HSL, fraction: number): {
    h: number;
    s: number;
    l: number;
};
export declare function hslDarkenLinear(hsl: HSL, lightness: number): {
    h: number;
    s: number;
    l: number;
};
export declare function hslAddSaturate(hsl: HSL, saturation: number): {
    h: number;
    s: number;
    l: number;
};
export declare function hslSetSaturate(hsl: HSL, saturation: number): {
    h: number;
    s: number;
    l: number;
};
