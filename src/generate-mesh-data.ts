/**
 * Generate mesh data for visualizing, equivalent to the reference Python NumPy code.
 * Returns X, Y, Z arrays as 2D arrays (number[][]).
 */

/**
 * Create a linearly spaced array (equivalent to np.linspace)
 */
function linspace(start: number, end: number, count: number): number[] {
  const step = (end - start) / (count - 1);
  return Array.from({ length: count }, (_, i) => start + i * step);
}

/**
 * Create meshgrid from x and y arrays (equivalent to np.meshgrid)
 * Returns [X, Y] where X and Y are 2D arrays
 */
function meshgrid(x: number[], y: number[]): [number[][], number[][]] {
  const X: number[][] = [];
  const Y: number[][] = [];

  for (let j = 0; j < y.length; j++) {
    X.push([]);
    Y.push([]);
    for (let i = 0; i < x.length; i++) {
      X[j].push(x[i]);
      Y[j].push(y[j]);
    }
  }

  return [X, Y];
}

/**
 * Generate the same mesh data as the Python code.
 * Equivalent to:
 *   x = np.linspace(-2, 2, 100)
 *   y = np.linspace(-2, 2, 100)
 *   X, Y = np.meshgrid(x, y)
 *   amplitude_scale = 0.3 + 0.7 * (X - x.min()) / (x.max() - x.min())
 *   Z = amplitude_scale * (
 *       np.cos(2 * np.pi * X) * (1 + 0.3 * Y)
 *       + 0.6 * np.cos(1.5 * np.pi * Y + 0.5 * X)
 *       + 0.3 * np.sin(3 * X * Y)
 *   )
 */
export function generateMeshData(
  xStart: number = -2,
  xEnd: number = 2,
  yStart: number = -2,
  yEnd: number = 2,
  count: number = 100
): { X: number[][]; Y: number[][]; Z: number[][] } {
  // Generate linspace arrays
  const x = linspace(xStart, xEnd, count);
  const y = linspace(yStart, yEnd, count);

  // Create meshgrid
  const [X, Y] = meshgrid(x, y);

  // Calculate min/max for normalization
  const xMin = Math.min(...x);
  const xMax = Math.max(...x);

  // Compute amplitude_scale and Z
  const Z: number[][] = [];

  for (let j = 0; j < Y.length; j++) {
    Z.push([]);
    for (let i = 0; i < X[j].length; i++) {
      const xVal = X[j][i];
      const yVal = Y[j][i];

      // Calculate amplitude_scale
      const amplitudeScale = 0.3 + 0.7 * (xVal - xMin) / (xMax - xMin);

      // Calculate Z value
      const zVal = amplitudeScale * (
        Math.cos(2 * Math.PI * xVal) * (1 + 0.3 * yVal) +
        0.6 * Math.cos(1.5 * Math.PI * yVal + 0.5 * xVal) +
        0.3 * Math.sin(3 * xVal * yVal)
      );

      Z[j].push(zVal);
    }
  }

  return { X, Y, Z };
}
