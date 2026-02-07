import { useState, useMemo, useCallback } from 'react'
import DeckGL, { type OrbitViewState } from 'deck.gl'
import { LineLayer, OrbitView, PointCloudLayer } from 'deck.gl'
import { useQueryState, parseAsInteger, createParser } from 'nuqs'
import { generateMeshData } from './generate-mesh-data'
import './App.css'
import { hslToRgbBuff, type hslColorBuff, type rgbColorBuff } from './color-utils'

type GradientKey = 'xBelow' | 'xAbove' | 'yBelow' | 'yAbove'

interface Gradient {
  high: hslColorBuff
  low: hslColorBuff
}

interface GradientState {
  xAbove: Gradient
  xBelow: Gradient
  yAbove: Gradient
  yBelow: Gradient
}

// Pre-allocated pool of rgb color buffers to reduce GC pressure during rapid re-renders on color/cutoff changes.
// The pool grows lazily to match peak demand, then stays stable.
const colorPool: [number, number, number, number][] = []
let colorPoolIndex = 0

function resetColorPool() {
  colorPoolIndex = 0
}

function acquireColorBuffer(): rgbColorBuff {
  if (colorPoolIndex >= colorPool.length) {
    colorPool.push([0, 0, 0, 255])
  }
  return colorPool[colorPoolIndex++]
}

// Convert hslColorBuff to CSS string for display
const toHslCss = (color: hslColorBuff): string =>
  `hsl(${color[0]} ${color[1] * 100}% ${color[2] * 100}%)`

const toRgbCss = (color: rgbColorBuff): string =>
  `rgb(${color[0]} ${color[1]} ${color[2]})`

// Linear interpolation between two HSL color buffers
const lerpHsl = (a: hslColorBuff, b: hslColorBuff, t: number): hslColorBuff => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
  a[3],
]

// Default gradient endpoints for each semantic region
// hslColorBuff: [h, s, l, alpha] — h in 0-360, s/l in 0-1, alpha in 0-255
const DEFAULT_GRADIENTS: GradientState = {
  xBelow: {
    high: [220, 0.60, 0.55, 255],  // Cornflower Blue
    low: [220, 0.70, 0.25, 255],  // Dark Blue
  },
  xAbove: {
    high: [200, 0.40, 0.75, 255],  // Light Blue
    low: [200, 0.50, 0.45, 255],  // Steel Blue
  },
  yBelow: {
    high: [10, 0.75, 0.50, 255],   // Tomato
    low: [0, 0.70, 0.30, 255],    // Dark Red
  },
  yAbove: {
    high: [40, 0.70, 0.70, 255],   // Light Orange
    low: [30, 0.80, 0.45, 255],   // Dark Orange
  },
}

// Custom parser for gradient state ( GradientState -> JSON) for use in the URL query state.
const parseAsGradients = createParser<GradientState>({
  parse: (value: string) => {
    try {
      const parsed = JSON.parse(value)
      const keys: GradientKey[] = ['xBelow', 'xAbove', 'yBelow', 'yAbove']
      for (const key of keys) {
        if (!Array.isArray(parsed[key]?.low) || parsed[key].low.length !== 4) return null
        if (!Array.isArray(parsed[key]?.high) || parsed[key].high.length !== 4) return null
        for (const val of [...parsed[key].low, ...parsed[key].high]) {
          if (typeof val !== 'number') return null
        }
      }
      return parsed as GradientState
    } catch {
      return null
    }
  },
  serialize: (value: GradientState) => JSON.stringify(value),
})

// Axis colors
const AXIS_COLORS = {
  axisX: [255, 80, 80, 255] as rgbColorBuff,   // Red
  axisY: [80, 200, 80, 255] as rgbColorBuff,    // Green
  axisZ: [80, 200, 255, 255] as rgbColorBuff,   // Cyan
}

interface ColoredSegment {
  sourcePosition: [number, number, number]
  targetPosition: [number, number, number]
  color: rgbColorBuff
}

interface AxisLine {
  sourcePosition: [number, number, number]
  targetPosition: [number, number, number]
  color: rgbColorBuff
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
  resetColorPool()
  const segments: ColoredSegment[] = []
  const rows = Z.length
  const cols = Z[0].length
  const zRange = zMax - zMin

  // Get gradient color for a given z value, writing into a pooled buffer
  const getGradientColor = (
    z: number,
    gradient: Gradient
  ): rgbColorBuff => {
    const t = zRange > 0 ? (z - zMin) / zRange : 0.5
    return hslToRgbBuff(lerpHsl(gradient.low, gradient.high, t), acquireColorBuffer())
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

// Channel metadata for the HSL sliders: display range and scale factor from 0-1 internal
const HSL_CHANNELS = [
  { label: 'H', max: 360, scale: 1 },
  { label: 'S', max: 100, scale: 100 },
  { label: 'L', max: 100, scale: 100 },
] as const

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
  const [hoverInfo, setHoverInfo] = useState<{
    x: number
    y: number
    object: { position: [number, number, number] }
  } | null>(null)
  const [pinnedInfo, setPinnedInfo] = useState<{
    x: number
    y: number
    object: { position: [number, number, number] }
  } | null>(null)

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

  // Original mesh vertices + z-cutoff intersection points for hover picking
  const hoverVertices = useMemo(() => {
    const rows = X.length
    const cols = X[0].length
    const vertices: { position: [number, number, number] }[] = []

    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        vertices.push({ position: [X[j][i], Y[j][i], Z[j][i]] })

        // Check X-direction edge for cutoff crossing
        if (i < cols - 1) {
          const z0 = Z[j][i], z1 = Z[j][i + 1]
          if ((z0 > zCutoff) !== (z1 > zCutoff)) {
            const t = (zCutoff - z0) / (z1 - z0)
            vertices.push({
              position: [
                X[j][i] + (X[j][i + 1] - X[j][i]) * t,
                Y[j][i] + (Y[j][i + 1] - Y[j][i]) * t,
                zCutoff,
              ]
            })
          }
        }

        // Check Y-direction edge for cutoff crossing
        if (j < rows - 1) {
          const z0 = Z[j][i], z1 = Z[j + 1][i]
          if ((z0 > zCutoff) !== (z1 > zCutoff)) {
            const t = (zCutoff - z0) / (z1 - z0)
            vertices.push({
              position: [
                X[j][i] + (X[j + 1][i] - X[j][i]) * t,
                Y[j][i] + (Y[j + 1][i] - Y[j][i]) * t,
                zCutoff,
              ]
            })
          }
        }
      }
    }

    return vertices
  }, [X, Y, Z, zCutoff])

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
    (key: GradientKey, end: 'low' | 'high', index: number, value: number) => {
      setGradients(prev => {
        const newColor: [number, number, number, number] = [...prev[key][end]]
        newColor[index] = value
        return {
          ...prev,
          [key]: {
            ...prev[key],
            [end]: newColor,
          },
        }
      })
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
      getSourcePosition: (data) => data.sourcePosition,
      getTargetPosition: (data) => data.targetPosition,
      getColor: (data) => data.color as [number, number, number, number],
      getWidth: 1,
      widthUnits: 'pixels',
    }),
    new LineLayer<AxisLine>({
      id: 'axes',
      data: axisLines,
      getSourcePosition: (data) => data.sourcePosition,
      getTargetPosition: (data) => data.targetPosition,
      getColor: (data) => data.color as [number, number, number, number],
      getWidth: 2,
      widthUnits: 'pixels',
    }),
    new PointCloudLayer({
      id: 'mesh-vertices',
      data: hoverVertices,
      getPosition: (d: { position: [number, number, number] }) => d.position,
      getColor: [255, 255, 255, 0],
      pointSize: 8,
      sizeUnits: 'pixels',
      pickable: true,
      onHover: (info) => {
        if (info.object) {
          setHoverInfo({ x: info.x, y: info.y, object: info.object })
        } else {
          setHoverInfo(null)
        }
      },
      onClick: (info) => {
        if (info.object) {
          setPinnedInfo({ x: info.x, y: info.y, object: info.object })
        }
      },
    }),
    ...((pinnedInfo || hoverInfo) ? [new PointCloudLayer({
      id: 'hover-marker',
      data: [(pinnedInfo ?? hoverInfo)!.object],
      getPosition: (d: { position: [number, number, number] }) => d.position,
      getColor: [255, 255, 255],
      pointSize: 6,
      sizeUnits: 'pixels',
      parameters: { depthTest: false },
    })] : []),
  ]

  return (
    <div className={`app-container ${darkMode ? 'dark' : 'light'}`}>
      <DeckGL
        views={new OrbitView({ id: 'orbit', orbitAxis: 'Z' })}
        initialViewState={INITIAL_VIEW_STATE}
        controller={true}
        layers={layers}
        onClick={(info) => {
          if (!info.object) {
            setPinnedInfo(null)
          }
        }}
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
          <span className="legend-color" style={{ backgroundColor: toRgbCss(AXIS_COLORS.axisX) }} />
          X axis
        </div>
        <div className="legend-item">
          <span className="legend-color" style={{ backgroundColor: toRgbCss(AXIS_COLORS.axisY) }} />
          Y axis
        </div>
        <div className="legend-item">
          <span className="legend-color" style={{ backgroundColor: toRgbCss(AXIS_COLORS.axisZ) }} />
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
                {(['high', 'low'] as const).map(end => (
                  <div key={end} className="gradient-endpoint">
                    <span className="endpoint-label">{end === 'low' ? 'Low Z' : 'High Z'}</span>
                    <div
                      className="color-preview"
                      style={{ background: toHslCss(gradients[key][end]) }}
                    />
                    {HSL_CHANNELS.map((ch, i) => (
                      <label key={ch.label}>
                        {ch.label}
                        <input
                          type="range"
                          min={0}
                          max={ch.max}
                          step={1}
                          value={Math.round(gradients[key][end][i] * ch.scale)}
                          onChange={(e) => updateGradientColor(key, end, i, parseFloat(e.target.value) / ch.scale)}
                        />
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {(() => {
        const info = pinnedInfo ?? hoverInfo
        if (!info) return null
        return (
          <div
            className={`tooltip ${pinnedInfo ? 'tooltip-pinned' : ''}`}
            style={{ left: info.x + 12, top: info.y - 12 }}
          >
            <div>X: {info.object.position[0].toFixed(3)}</div>
            <div>Y: {info.object.position[1].toFixed(3)}</div>
            <div>Z: {info.object.position[2].toFixed(3)}</div>
          </div>
        )
      })()}
    </div>
  )
}

export default App
