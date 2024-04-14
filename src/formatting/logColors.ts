import { hslToHex, hslToRGB } from "./colors";

function ansiHSL(h: number, s: number, l: number, text: string): string {
    let { r, g, b } = hslToRGB({ h, s, l });
    return ansiRGB(r, g, b, text);
}
function ansiRGB(r: number, g: number, b: number, text: string): string {
    return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

const lightness = 68;
export const blue = (text: string) => `\x1b[34m${text}\x1b[0m`;
export const red = ansiHSL.bind(null, 0, 100, lightness);
export const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
export const yellow = (text: string) => `\x1b[33m${text}\x1b[0m`;
export const white = ansiHSL.bind(null, 0, 0, 80);

export const magenta = (text: string) => `\x1b[35m${text}\x1b[0m`;

console.log(blue('blue'));