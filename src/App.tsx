import { useState, useMemo, useCallback } from 'react'
import DeckGL, { type OrbitViewState } from 'deck.gl'
import { LineLayer, OrbitView } from 'deck.gl'
import { generateMeshData } from './generate-mesh-data'
import './App.css'

type Color = [number, number, number, number]
type GradientKey = 'xBelow' | 'xAbove' | 'yBelow' | 'yAbove'

interface Gradient {
  low: Color
  high: Color
}

interface GradientState {
  xBelow: Gradient
  xAbove: Gradient
  yBelow: Gradient
  yAbove: Gradient
}

// Default gradient endpoints for each semantic region
const DEFAULT_GRADIENTS: GradientState = {
  xBelow: {
    low: [20, 40, 120, 255],      // Dark Blue
    high: [100, 149, 237, 255],   // Cornflower Blue
  },
  xAbove: {
    low: [70, 130, 180, 255],     // Steel Blue
    high: [173, 216, 230, 255],   // Light Blue
  },
  yBelow: {
    low: [139, 0, 0, 255],        // Dark Red
    high: [255, 99, 71, 255],     // Tomato
  },
  yAbove: {
    low: [180, 90, 0, 255],       // Dark Orange
    high: [255, 200, 100, 255],   // Light Orange
  },
}

// Convert RGB array to hex string for color picker
function rgbToHex(color: Color): string {
  const [r, g, b] = color
  return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')
}

// Convert hex string to RGB array
function hexToRgb(hex: string): Color {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!result) return [0, 0, 0, 255]
  return [
    parseInt(result[1], 16),
    parseInt(result[2], 16),
    parseInt(result[3], 16),
    255,
  ]
}

// Axis colors
const AXIS_COLORS = {
  axisX: [255, 80, 80, 255] as Color,      // Red
  axisY: [80, 200, 80, 255] as Color,      // Green
  axisZ: [80, 200, 255, 255] as Color,     // Cyan
}

/**
 * Interpolate between two colors based on normalized t value (0-1)
 */
function lerpColor(a: Color, b: Color, t: number): Color {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
    Math.round(a[3] + (b[3] - a[3]) * t),
  ]
}

interface ColoredSegment {
  sourcePosition: [number, number, number]
  targetPosition: [number, number, number]
  color: Color
}

interface AxisLine {
  sourcePosition: [number, number, number]
  targetPosition: [number, number, number]
  color: Color
}

/**
 * Linear interpolation between two 3D points
 */
function lerp3(
  a: [number, number, number],
  b: [number, number, number],
  t: number
): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ]
}

// Number of subdivisions per mesh edge for smooth gradients
const GRADIENT_SUBDIVISIONS = 8

/**
 * Convert mesh data to colored line segments, splitting at the Z cutoff plane.
 * Segments are subdivided to create smooth z-based color gradients.
 */
function meshToColoredSegments(
  X: number[][],
  Y: number[][],
  Z: number[][],
  zCutoff: number,
  zMin: number,
  zMax: number,
  gradients: GradientState
): ColoredSegment[] {
  const segments: ColoredSegment[] = []
  const rows = Z.length
  const cols = Z[0].length
  const zRange = zMax - zMin

  // Get gradient color for a given z value and gradient type
  const getGradientColor = (
    z: number,
    gradient: Gradient
  ): Color => {
    const t = zRange > 0 ? (z - zMin) / zRange : 0.5
    return lerpColor(gradient.low, gradient.high, t)
  }

  // Add a single small segment with color based on midpoint z
  const addSubSegment = (
    p1: [number, number, number],
    p2: [number, number, number],
    gradient: Gradient
  ) => {
    const midZ = (p1[2] + p2[2]) / 2
    segments.push({
      sourcePosition: p1,
      targetPosition: p2,
      color: getGradientColor(midZ, gradient),
    })
  }

  // Process a segment that's entirely on one side of the cutoff
  const subdivideSegment = (
    source: [number, number, number],
    target: [number, number, number],
    gradient: Gradient
  ) => {
    for (let i = 0; i < GRADIENT_SUBDIVISIONS; i++) {
      const t1 = i / GRADIENT_SUBDIVISIONS
      const t2 = (i + 1) / GRADIENT_SUBDIVISIONS
      const p1 = lerp3(source, target, t1)
      const p2 = lerp3(source, target, t2)
      addSubSegment(p1, p2, gradient)
    }
  }

  const processSegment = (
    source: [number, number, number],
    target: [number, number, number],
    direction: 'x' | 'y'
  ) => {
    const sourceZ = source[2]
    const targetZ = target[2]
    const sourceAbove = sourceZ > zCutoff
    const targetAbove = targetZ > zCutoff

    const gradientBelow = direction === 'x' ? gradients.xBelow : gradients.yBelow
    const gradientAbove = direction === 'x' ? gradients.xAbove : gradients.yAbove

    if (sourceAbove === targetAbove) {
      // Entire segment is on one side of cutoff
      const gradient = sourceAbove ? gradientAbove : gradientBelow
      subdivideSegment(source, target, gradient)
    } else {
      // Segment crosses the cutoff - split it first, then subdivide each half
      const t = (zCutoff - sourceZ) / (targetZ - sourceZ)
      const midPoint = lerp3(source, target, t)

      // First half (from source to midpoint)
      const sourceGradient = sourceAbove ? gradientAbove : gradientBelow
      subdivideSegment(source, midPoint, sourceGradient)

      // Second half (from midpoint to target)
      const targetGradient = targetAbove ? gradientAbove : gradientBelow
      subdivideSegment(midPoint, target, targetGradient)
    }
  }

  // X-direction lines
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols - 1; i++) {
      processSegment(
        [X[j][i], Y[j][i], Z[j][i]],
        [X[j][i + 1], Y[j][i + 1], Z[j][i + 1]],
        'x'
      )
    }
  }

  // Y-direction lines
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols; i++) {
      processSegment(
        [X[j][i], Y[j][i], Z[j][i]],
        [X[j + 1][i], Y[j + 1][i], Z[j + 1][i]],
        'y'
      )
    }
  }

  return segments
}

const INITIAL_VIEW_STATE: OrbitViewState = {
  target: [0, 0, 0],
  rotationX: 40,
  rotationOrbit: -45,
  zoom: 7,
  minZoom: 1,
  maxZoom: 10,
}

function App() {
  const [zCutoff, setZCutoff] = useState(0)
  const [gradients, setGradients] = useState<GradientState>(DEFAULT_GRADIENTS)
  const [editingGradient, setEditingGradient] = useState<GradientKey | null>(null)
  const [darkMode, setDarkMode] = useState(true)

  const updateGradientColor = useCallback(
    (key: GradientKey, end: 'low' | 'high', hex: string) => {
      setGradients(prev => ({
        ...prev,
        [key]: {
          ...prev[key],
          [end]: hexToRgb(hex),
        },
      }))
    },
    []
  )

  // Generate mesh data once
  const { X, Y, Z, zMin, zMax } = useMemo(() => {
    const data = generateMeshData(-2, 2, -2, 2, 100)

    let min = Infinity
    let max = -Infinity
    for (const row of data.Z) {
      for (const z of row) {
        if (z < min) min = z
        if (z > max) max = z
      }
    }

    return { ...data, zMin: min, zMax: max }
  }, [])

  // Create colored segments with cutoff splitting (recomputed when cutoff or gradients change)
  const coloredSegments = useMemo(
    () => meshToColoredSegments(X, Y, Z, zCutoff, zMin, zMax, gradients),
    [X, Y, Z, zCutoff, zMin, zMax, gradients]
  )

  // Create axis lines at the edges of the bounding box
  const axisLines: AxisLine[] = useMemo(() => {
    const xMin = -2, xMax = 2
    const yMin = -2, yMax = 2

    return [
      {
        sourcePosition: [xMin, yMax, zMin],
        targetPosition: [xMax, yMax, zMin],
        color: AXIS_COLORS.axisX,
      },
      {
        sourcePosition: [xMin, yMin, zMin],
        targetPosition: [xMin, yMax, zMin],
        color: AXIS_COLORS.axisY,
      },
      {
        sourcePosition: [xMin, yMin, zMin],
        targetPosition: [xMin, yMin, zMax],
        color: AXIS_COLORS.axisZ,
      },
    ]
  }, [zMin, zMax])

  const layers = [
    new LineLayer<ColoredSegment>({
      id: 'wireframe',
      data: coloredSegments,
      getSourcePosition: (d) => d.sourcePosition,
      getTargetPosition: (d) => d.targetPosition,
      getColor: (d) => d.color,
      getWidth: 1,
      widthUnits: 'pixels',
    }),
    new LineLayer<AxisLine>({
      id: 'axes',
      data: axisLines,
      getSourcePosition: (d) => d.sourcePosition,
      getTargetPosition: (d) => d.targetPosition,
      getColor: (d) => d.color,
      getWidth: 2,
      widthUnits: 'pixels',
    }),
  ]

  return (
    <div className={`app-container ${darkMode ? 'dark' : 'light'}`}>
      <DeckGL
        views={new OrbitView({ id: 'orbit', orbitAxis: 'Z' })}
        initialViewState={INITIAL_VIEW_STATE}
        controller={true}
        layers={layers}
      />

      <div className="controls">
        <label>
          Z Cutoff: {zCutoff.toFixed(2)}
          <input
            type="range"
            min={zMin}
            max={zMax}
            step={(zMax - zMin) / 100}
            value={zCutoff}
            onChange={(e) => setZCutoff(parseFloat(e.target.value))}
          />
        </label>
        <button
          className="theme-toggle"
          onClick={() => setDarkMode(!darkMode)}
        >
          {darkMode ? 'Light Mode' : 'Dark Mode'}
        </button>
      </div>

      <div className="legend">
        <div className="legend-title">Axes</div>
        <div className="legend-item">
          <span className="legend-color" style={{ backgroundColor: `rgb(${AXIS_COLORS.axisX.slice(0, 3).join(',')})` }} />
          X axis
        </div>
        <div className="legend-item">
          <span className="legend-color" style={{ backgroundColor: `rgb(${AXIS_COLORS.axisY.slice(0, 3).join(',')})` }} />
          Y axis
        </div>
        <div className="legend-item">
          <span className="legend-color" style={{ backgroundColor: `rgb(${AXIS_COLORS.axisZ.slice(0, 3).join(',')})` }} />
          Z axis
        </div>
        <div className="legend-title" style={{ marginTop: '12px' }}>Wireframe (click to edit)</div>
        {([
          ['xBelow', 'X direction (below cutoff)'],
          ['xAbove', 'X direction (above cutoff)'],
          ['yBelow', 'Y direction (below cutoff)'],
          ['yAbove', 'Y direction (above cutoff)'],
        ] as const).map(([key, label]) => (
          <div key={key} className="legend-gradient-item">
            <div
              className="legend-item legend-item-clickable"
              onClick={() => setEditingGradient(editingGradient === key ? null : key)}
            >
              <span
                className="legend-gradient"
                style={{
                  background: `linear-gradient(to right, rgb(${gradients[key].low.slice(0, 3).join(',')}), rgb(${gradients[key].high.slice(0, 3).join(',')}))`
                }}
              />
              {label}
            </div>
            {editingGradient === key && (
              <div className="gradient-editor">
                <label>
                  Low Z
                  <input
                    type="color"
                    value={rgbToHex(gradients[key].low)}
                    onChange={(e) => updateGradientColor(key, 'low', e.target.value)}
                  />
                </label>
                <label>
                  High Z
                  <input
                    type="color"
                    value={rgbToHex(gradients[key].high)}
                    onChange={(e) => updateGradientColor(key, 'high', e.target.value)}
                  />
                </label>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

export default App
