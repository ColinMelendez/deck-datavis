
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
    out[0] = Math.round(hueToRGB(p, q, h + 1 / 3) * 255);
    out[1] = Math.round(hueToRGB(p, q, h) * 255);
    out[2] = Math.round(hueToRGB(p, q, h - 1 / 3) * 255);
  }

  return out
}

function hueToRGB(p: number, q: number, t: number) {
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
