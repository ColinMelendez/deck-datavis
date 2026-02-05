import { useState, useMemo, useCallback } from 'react'
import DeckGL, { type OrbitViewState } from 'deck.gl'
import { LineLayer, OrbitView } from 'deck.gl'
import { useQueryState, parseAsInteger, createParser } from 'nuqs'
import { generateMeshData } from './generate-mesh-data'
import './App.css'
import { hslToRgbFast } from './utils'

type RgbaArray = [number, number, number, number]
type GradientKey = 'xBelow' | 'xAbove' | 'yBelow' | 'yAbove'

// HSL color representation (intuitive controls)
interface HslColor {
  h: number // 0-360 (hue)
  s: number // 0-100 (saturation %)
  l: number // 0-100 (lightness %)
}

interface Gradient {
  low: HslColor
  high: HslColor
}

interface GradientState {
  xBelow: Gradient
  xAbove: Gradient
  yBelow: Gradient
  yAbove: Gradient
}

const toRgbArray = (color: HslColor): RgbaArray => {
  const buff: number[] = [0, 0, 0, 255]
  hslToRgbFast(color.h / 360, color.s / 100, color.l / 100, buff)
  return buff as RgbaArray
}

// Convert HslColor to CSS string for display
const toHslCss = (color: HslColor): string =>
  `hsl(${color.h}, ${color.s}%, ${color.l}%)`

// Linear interpolation between two HSL colors
const lerpHsl = (a: HslColor, b: HslColor, t: number): HslColor => ({
  h: a.h + (b.h - a.h) * t,
  s: a.s + (b.s - a.s) * t,
  l: a.l + (b.l - a.l) * t,
})

// Default gradient endpoints for each semantic region (HSL)
const DEFAULT_GRADIENTS: GradientState = {
  xBelow: {
    low: { h: 220, s: 70, l: 25 },   // Dark Blue
    high: { h: 220, s: 60, l: 55 },  // Cornflower Blue
  },
  xAbove: {
    low: { h: 200, s: 50, l: 45 },   // Steel Blue
    high: { h: 200, s: 40, l: 75 },  // Light Blue
  },
  yBelow: {
    low: { h: 0, s: 70, l: 30 },     // Dark Red
    high: { h: 10, s: 75, l: 50 },   // Tomato
  },
  yAbove: {
    low: { h: 30, s: 80, l: 45 },    // Dark Orange
    high: { h: 40, s: 70, l: 70 },   // Light Orange
  },
}

// Custom parser for gradient state (JSON serialization)
const parseAsGradients = createParser<GradientState>({
  parse: (value: string) => {
    try {
      const parsed = JSON.parse(value)
      const keys: GradientKey[] = ['xBelow', 'xAbove', 'yBelow', 'yAbove']
      for (const key of keys) {
        if (!parsed[key]?.low || !parsed[key]?.high) return null
        const { low, high } = parsed[key]
        if (typeof low.h !== 'number' || typeof low.s !== 'number' || typeof low.l !== 'number') return null
        if (typeof high.h !== 'number' || typeof high.s !== 'number' || typeof high.l !== 'number') return null
      }
      return parsed as GradientState
    } catch {
      return null
    }
  },
  serialize: (value: GradientState) => JSON.stringify(value),
})

// Axis colors (static, no editing needed)
const AXIS_COLORS = {
  axisX: [255, 80, 80, 255] as RgbaArray,   // Red
  axisY: [80, 200, 80, 255] as RgbaArray,   // Green
  axisZ: [80, 200, 255, 255] as RgbaArray,  // Cyan
}

interface ColoredSegment {
  sourcePosition: [number, number, number]
  targetPosition: [number, number, number]
  color: RgbaArray
}

interface AxisLine {
  sourcePosition: [number, number, number]
  targetPosition: [number, number, number]
  color: RgbaArray
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
  ): RgbaArray => {
    const t = zRange > 0 ? (z - zMin) / zRange : 0.5
    return toRgbArray(lerpHsl(gradient.low, gradient.high, t))
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
  minZoom: 6,
  maxZoom: 12,
}

function App() {
  const [zCutoffPercent, setZCutoffPercent] = useQueryState(
    'zCutoff',
    parseAsInteger.withDefault(50)
  )
  const [editingZCutoff, setEditingZCutoff] = useState(false)
  const [zCutoffInput, setZCutoffInput] = useState('')
  const [gradients, setGradients] = useQueryState(
    'gradients',
    parseAsGradients.withDefault(DEFAULT_GRADIENTS)
  )
  const [editingGradient, setEditingGradient] = useState<GradientKey | null>(null)
  const [darkMode, setDarkMode] = useState(true)

  // Generate mesh data once (moved up so zMin/zMax are available for callbacks)
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

  // Convert percentage to actual z value
  const zCutoff = zMin + (zCutoffPercent / 100) * (zMax - zMin)

  const handleZCutoffSubmit = useCallback(() => {
    const value = parseFloat(zCutoffInput)
    if (!isNaN(value)) {
      setZCutoffPercent(Math.max(0, Math.min(100, value)))
    }
    setEditingZCutoff(false)
  }, [zCutoffInput, setZCutoffPercent])

  const startEditingZCutoff = useCallback(() => {
    setZCutoffInput(zCutoffPercent.toFixed(0))
    setEditingZCutoff(true)
  }, [zCutoffPercent])

  const updateGradientColor = useCallback(
    (key: GradientKey, end: 'low' | 'high', channel: 'h' | 's' | 'l', value: number) => {
      setGradients(prev => ({
        ...prev,
        [key]: {
          ...prev[key],
          [end]: {
            ...prev[key][end],
            [channel]: value,
          },
        },
      }))
    },
    [setGradients]
  )

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
        <div className="control-row">
          <span>Z Cutoff: </span>
          {editingZCutoff ? (
            <input
              type="number"
              className="z-cutoff-input"
              value={zCutoffInput}
              onChange={(e) => setZCutoffInput(e.target.value)}
              onBlur={handleZCutoffSubmit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleZCutoffSubmit()
                if (e.key === 'Escape') setEditingZCutoff(false)
              }}
              step="1"
              min="0"
              max="100"
              autoFocus
            />
          ) : (
            <span
              className="z-cutoff-value"
              onClick={startEditingZCutoff}
              title="Click to edit"
            >
              {zCutoffPercent.toFixed(0)}%
            </span>
          )}
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={zCutoffPercent}
          onChange={(e) => setZCutoffPercent(parseFloat(e.target.value))}
        />
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
                  background: `linear-gradient(to right, ${toHslCss(gradients[key].low)}, ${toHslCss(gradients[key].high)})`
                }}
              />
              {label}
            </div>
            {editingGradient === key && (
              <div className="gradient-editor">
                {(['low', 'high'] as const).map(end => (
                  <div key={end} className="gradient-endpoint">
                    <span className="endpoint-label">{end === 'low' ? 'Low Z' : 'High Z'}</span>
                    <div
                      className="color-preview"
                      style={{ background: toHslCss(gradients[key][end]) }}
                    />
                    <label>
                      H
                      <input
                        type="range"
                        min={0}
                        max={360}
                        step={1}
                        value={gradients[key][end].h}
                        onChange={(e) => updateGradientColor(key, end, 'h', parseFloat(e.target.value))}
                      />
                    </label>
                    <label>
                      S
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={gradients[key][end].s}
                        onChange={(e) => updateGradientColor(key, end, 's', parseFloat(e.target.value))}
                      />
                    </label>
                    <label>
                      L
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={gradients[key][end].l}
                        onChange={(e) => updateGradientColor(key, end, 'l', parseFloat(e.target.value))}
                      />
                    </label>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

export default App
