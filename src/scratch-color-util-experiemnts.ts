

interface HslColorStruct {
  h: number
  s: number
  l: number
}

interface RgbColorStruct {
  r: number
  g: number
  b: number
}
/**
 *  Convert from rgb values to hsl values
 *
 * @param r - Red value (0-255)
 * @param g - Green value (0-255)
 * @param b - Blue value (0-255)
 * @returns HSL values (h: 0-360, s: 0-100, l: 0-100)
 */
export function rgbToHSL(r: number, g: number, b: number, out: number[]) {
  // normalize inputs to 0-1
  r /= 255;
  g /= 255;
  b /= 255;

  const l = Math.max(r, g, b);
  const s = l - Math.min(r, g, b);
  const h = s
    ? l === r
      ? (g - b) / s
      : l === g
        ? 2 + (b - r) / s
        : 4 + (r - g) / s
    : 0;

  out[0] = 60 * h < 0 ? 60 * h + 360 : 60 * h
  out[1] = 100 * (s ? (l <= 0.5 ? s / (2 * l - s) : s / (2 - (2 * l - s))) : 0)
  out[2] = (100 * (2 * l - s)) / 2
}


export function rgb2hslFast(r: number, g: number, b: number, out: number[]) {
  // normalize inputs to 0-1
  r /= 255;
  g /= 255;
  b /= 255;

  const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
  const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
  const c = max - min;

  let hue = 0;
  let sat = 0;
  const lum = (max + min) * 0.5;

  if (c !== 0) {
    if (max === r) {
      hue = (g - b) / c + (g < b ? 6 : 0);
    } else if (max === g) {
      hue = (b - r) / c + 2;
    } else {
      hue = (r - g) / c + 4;
    }
    hue *= 60;

    sat = c / (1 - Math.abs(2 * lum - 1));
  }

  out[0] = hue;
  out[1] = sat * 100;
  out[2] = lum * 100;

  return out
}

export function hslToRgbFast(h: number, s: number, l: number, out: number[]) {
  // Unsafe: assumes h, s, and l inputs are in the range 0-1

  // if saturation is 0, the color only exists on the black/white axis defined by it's lightness
  if (s === 0) {
    out[0] = out[1] = out[2] = Math.round(l * 255);
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    out[0] = Math.round(computeRGBComponent(p, q, h + 1 / 3) * 255);
    out[1] = Math.round(computeRGBComponent(p, q, h) * 255);
    out[2] = Math.round(computeRGBComponent(p, q, h - 1 / 3) * 255);
  }

  return out
}

/**
 * Computes a single RGB component value from normalized hue and HSL-derived p/q values.
 * This is a helper function used in HSL to RGB conversion, called three times
 * with different hue offsets to compute R, G, and B components.
 *
 * @param p - Intermediate value derived from lightness (min RGB value)
 * @param q - Intermediate value derived from lightness and saturation (max RGB value)
 * @param t - Normalized hue value (0-1) with offset for the specific RGB component
 * @returns RGB component value in the range [0, 1]
 */
function computeRGBComponent(p: number, q: number, t: number) {
  if (t < 0) {
    t += 1
  }
  else if (t > 1) {
    t -= 1
  }
  if (t < 1 / 6) {
    return p + (q - p) * 6 * t
  }
  if (t < 1 / 2) {
    return q
  }
  if (t < 2 / 3) {
    return p + (q - p) * (2 / 3 - t) * 6
  }
  return p
}


export function hslToRgbFastStruct(hslColorIn: HslColorStruct, rgbColorOut: RgbColorStruct) {
  // Unsafe: assumes h, s, and l inputs are in the range 0-1

  // if saturation is 0, the color only exists on the black/white axis defined by it's lightness
  if (hslColorIn.s === 0) {
    rgbColorOut.r = rgbColorOut.g = rgbColorOut.b = Math.round(hslColorIn.l * 255);
  } else {
    const q = hslColorIn.l < 0.5 ? hslColorIn.l * (1 + hslColorIn.s) : hslColorIn.l + hslColorIn.s - hslColorIn.l * hslColorIn.s;
    const p = 2 * hslColorIn.l - q;
    rgbColorOut.r = Math.round(computeRGBComponent(p, q, hslColorIn.h + 1 / 3) * 255);
    rgbColorOut.g = Math.round(computeRGBComponent(p, q, hslColorIn.h) * 255);
    rgbColorOut.b = Math.round(computeRGBComponent(p, q, hslColorIn.h - 1 / 3) * 255);
  }

  return rgbColorOut
}


// Maybe this is how we can do the design of the buffers in the library.
// just make then readonly Arrays and then use the unsafe writes to the buffer internally.
// Technically users could do the same and break the type system, which is a bit of a footgun,
// but it's honestly probably an acceptable footgun.

export type hslColorBuff = readonly [number, number, number, number]
export type rgbColorBuff = readonly [number, number, number, number]

export function hslToRgbBuff(hslColorIn: hslColorBuff, rgbColorOut: rgbColorBuff = [0, 0, 0, 255]): rgbColorBuff {
  // Unsafe: assumes h, s, and l inputs are in the range 0-1

  // alpha unaffected
  // @ts-expect-error readonly array -- we are writing to the buffer
  rgbColorOut[3] = hslColorIn[3];

  // if saturation is 0, the color only exists on the black/white axis defined by it's lightness
  if (hslColorIn[1] === 0) {
    // @ts-expect-error readonly array -- we are writing to the buffer
    rgbColorOut[0] = rgbColorOut[1] = rgbColorOut[2]
      = Math.round(hslColorIn[2] * 255);
  } else {
    const q = hslColorIn[2] < 0.5 ? hslColorIn[2] * (1 + hslColorIn[1]) : hslColorIn[2] + hslColorIn[1] - hslColorIn[2] * hslColorIn[1];
    const p = 2 * hslColorIn[2] - q;
    // @ts-expect-error readonly array -- we are writing to the buffer
    rgbColorOut[0]
      = Math.round(computeRGBComponent(p, q, hslColorIn[0] + 1 / 3) * 255);
    // @ts-expect-error readonly array -- we are writing to the buffer
    rgbColorOut[1]
      = Math.round(computeRGBComponent(p, q, hslColorIn[0]) * 255);
    // @ts-expect-error readonly array -- we are writing to the buffer
    rgbColorOut[2]
      = Math.round(computeRGBComponent(p, q, hslColorIn[0] - 1 / 3) * 255);
  }

  return rgbColorOut;
}