
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

// Maybe this is how we can do the design of the buffers in the library.
// just make then readonly Arrays and then use the unsafe writes to the buffer internally.
// Technically users could do the same and break the type system, which is a bit of a footgun,
// but it's honestly probably an acceptable footgun.

export type hslColorBuff = readonly [number, number, number, number]
export type rgbColorBuff = readonly [number, number, number, number]

export function hslToRgbBuff(hslColorIn: hslColorBuff, rgbColorOut: rgbColorBuff = [0, 0, 0, 255]): rgbColorBuff {
  // Unsafe: assumes h is in the range 0-360, s, and l inputs are in the range 0-1

  const normalizedHue = hslColorIn[0] / 360;

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
      = Math.round(computeRGBComponent(p, q, normalizedHue + 1 / 3) * 255);
    // @ts-expect-error readonly array -- we are writing to the buffer
    rgbColorOut[1]
      = Math.round(computeRGBComponent(p, q, normalizedHue) * 255);
    // @ts-expect-error readonly array -- we are writing to the buffer
    rgbColorOut[2]
      = Math.round(computeRGBComponent(p, q, normalizedHue - 1 / 3) * 255);
  }

  return rgbColorOut;
}