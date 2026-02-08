import { useState, useMemo, useCallback } from 'react'
import DeckGL, { type OrbitViewState } from 'deck.gl'
import { LineLayer, OrbitView, PointCloudLayer } from 'deck.gl'
import { useQueryState, parseAsInteger, createParser } from 'nuqs'
import { generateMeshData } from './generate-mesh-data'
import './App.css'
import { hslToRgbBuff, type hslColorBuff, type rgbColorBuff } from './color-utils'

type GradientKey = 'xBelow' | 'xAbove' | 'yBelow' | 'yAbove'

// A gradient object defined by a high and low endpoint in HSL space.
interface Gradient {
  high: hslColorBuff
  low: hslColorBuff
}

// The active set of gradients.
interface ActiveGradientsState {
  xAbove: Gradient
  xBelow: Gradient
  yAbove: Gradient
  yBelow: Gradient
}

// Pre-allocated typed-array buffers for segment data, eliminating per-segment
// object allocation. Buffers grow lazily to match peak demand, then stay stable.
interface SegmentBuffers {
  sourcePositions: Float32Array
  targetPositions: Float32Array
  colors: Uint8ClampedArray
  lineKeys: string[]
  count: number
}

let _segBuf: SegmentBuffers | null = null

function getSegmentBuffers(capacity: number): SegmentBuffers {
  if (!_segBuf || _segBuf.lineKeys.length < capacity) {
    _segBuf = {
      sourcePositions: new Float32Array(capacity * 3),
      targetPositions: new Float32Array(capacity * 3),
      colors: new Uint8ClampedArray(capacity * 4),
      lineKeys: new Array(capacity),
      count: 0,
    }
  }
  _segBuf.count = 0
  return _segBuf
}

// Interned line key strings to avoid repeated template literal allocation
const _rowKeys: string[] = []
const _colKeys: string[] = []
const rowKey = (j: number): string => _rowKeys[j] ??= `row-${j}`
const colKey = (i: number): string => _colKeys[i] ??= `col-${i}`

// Convert hslColorBuff to CSS string for display
const toHslCss = (color: hslColorBuff): string =>
  `hsl(${color[0]} ${color[1] * 100}% ${color[2] * 100}%)`

const toRgbCss = (color: rgbColorBuff): string =>
  `rgb(${color[0]} ${color[1]} ${color[2]})`


// Default gradient endpoints for each semantic region
// hslColorBuff: [h, s, l, alpha] — h in 0-360, s/l in 0-1, alpha in 0-255
const DEFAULT_GRADIENTS: ActiveGradientsState = {
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
const gradientsStateParser = createParser<ActiveGradientsState>({
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
      return parsed as ActiveGradientsState
    } catch {
      return null
    }
  },
  serialize: (value: ActiveGradientsState) => JSON.stringify(value),
})

const AXIS_COLORS = {
  axisX: [255, 80, 80, 255] as rgbColorBuff,
  axisY: [80, 200, 80, 255] as rgbColorBuff,
  axisZ: [80, 200, 255, 255] as rgbColorBuff,
}

// Constituents of a layer that exist for targeting with hover tooltips.
interface HoverVertex {
  position: [number, number, number]
  lineKeys: string[]
}

// Location and associated vertex being hovered over.
interface HoverPoint {
  x: number
  y: number
  object: HoverVertex
}

// Constituents of the axes layer; basically just for rendering the lines representing the graph axes.
interface AxisLine {
  sourcePosition: [number, number, number]
  targetPosition: [number, number, number]
  color: rgbColorBuff
}

// Number of subdivisions per mesh edge for smooth gradients
const GRADIENT_SUBDIVISIONS = 8



/**
 * Fill pre-allocated typed-array buffers with colored line segments,
 * splitting at the Z cutoff plane and subdividing for smooth gradients.
 *
 * The id of the returned object is new on every call, but the underlying typed arrays are reused.
 */
function fillSegmentBuffers(
  X: number[][],
  Y: number[][],
  Z: number[][],
  zCutoff: number,
  zMin: number,
  zMax: number,
  gradients: ActiveGradientsState
): SegmentBuffers {
  const rows = Z.length
  const cols = Z[0].length
  const zRange = zMax - zMin

  // Worst case: every edge crosses cutoff → 2 halves × GRADIENT_SUBDIVISIONS each
  const maxEdges = rows * (cols - 1) + (rows - 1) * cols
  const maxSegments = maxEdges * 2 * GRADIENT_SUBDIVISIONS
  const buf = getSegmentBuffers(maxSegments)
  let idx = 0

  // Temporary HSL/RGB buffers reused across all color computations
  const _tempHsl: [number, number, number, number] = [0, 0, 0, 255]
  const _tempRgb: [number, number, number, number] = [0, 0, 0, 255]

  // Write one sub-segment directly into the typed arrays
  const writeSubSegment = (
    p1x: number, p1y: number, p1z: number,
    p2x: number, p2y: number, p2z: number,
    gradient: Gradient,
    key: string
  ) => {
    const sOff = idx * 3
    buf.sourcePositions[sOff] = p1x
    buf.sourcePositions[sOff + 1] = p1y
    buf.sourcePositions[sOff + 2] = p1z
    buf.targetPositions[sOff] = p2x
    buf.targetPositions[sOff + 1] = p2y
    buf.targetPositions[sOff + 2] = p2z

    // Color from gradient based on midpoint z
    const t = zRange > 0 ? ((p1z + p2z) / 2 - zMin) / zRange : 0.5
    _tempHsl[0] = gradient.low[0] + (gradient.high[0] - gradient.low[0]) * t
    _tempHsl[1] = gradient.low[1] + (gradient.high[1] - gradient.low[1]) * t
    _tempHsl[2] = gradient.low[2] + (gradient.high[2] - gradient.low[2]) * t
    _tempHsl[3] = gradient.low[3]
    hslToRgbBuff(_tempHsl, _tempRgb)

    const cOff = idx * 4
    buf.colors[cOff] = _tempRgb[0]
    buf.colors[cOff + 1] = _tempRgb[1]
    buf.colors[cOff + 2] = _tempRgb[2]
    buf.colors[cOff + 3] = _tempRgb[3]

    buf.lineKeys[idx] = key
    idx++
  }

  // Subdivide a segment into GRADIENT_SUBDIVISIONS pieces (all scalar, no tuple allocation)
  const subdivide = (
    sx: number, sy: number, sz: number,
    tx: number, ty: number, tz: number,
    gradient: Gradient,
    key: string
  ) => {
    const dx = tx - sx, dy = ty - sy, dz = tz - sz
    for (let k = 0; k < GRADIENT_SUBDIVISIONS; k++) {
      const t1 = k / GRADIENT_SUBDIVISIONS
      const t2 = (k + 1) / GRADIENT_SUBDIVISIONS
      writeSubSegment(
        sx + dx * t1, sy + dy * t1, sz + dz * t1,
        sx + dx * t2, sy + dy * t2, sz + dz * t2,
        gradient, key
      )
    }
  }

  const processEdge = (
    sx: number, sy: number, sz: number,
    tx: number, ty: number, tz: number,
    direction: 'x' | 'y',
    key: string
  ) => {
    const sAbove = sz > zCutoff
    const tAbove = tz > zCutoff
    const gradBelow = direction === 'x' ? gradients.xBelow : gradients.yBelow
    const gradAbove = direction === 'x' ? gradients.xAbove : gradients.yAbove

    if (sAbove === tAbove) {
      // Both endpoints on the same side -> subdivide normally with one gradient
      subdivide(sx, sy, sz, tx, ty, tz, sAbove ? gradAbove : gradBelow, key)
    } else {
      // Split at cutoff crossing
      const f = (zCutoff - sz) / (tz - sz)
      const mx = sx + (tx - sx) * f
      const my = sy + (ty - sy) * f
      subdivide(sx, sy, sz, mx, my, zCutoff, sAbove ? gradAbove : gradBelow, key)
      subdivide(mx, my, zCutoff, tx, ty, tz, tAbove ? gradAbove : gradBelow, key)
    }
  }

  // X-direction lines
  for (let j = 0; j < rows; j++) {
    const rk = rowKey(j)
    for (let i = 0; i < cols - 1; i++) {
      processEdge(
        X[j][i], Y[j][i], Z[j][i],
        X[j][i + 1], Y[j][i + 1], Z[j][i + 1],
        'x', rk
      )
    }
  }

  // Y-direction lines
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols; i++) {
      processEdge(
        X[j][i], Y[j][i], Z[j][i],
        X[j + 1][i], Y[j + 1][i], Z[j + 1][i],
        'y', colKey(i)
      )
    }
  }

  buf.count = idx

  return {
    sourcePositions: buf.sourcePositions,
    targetPositions: buf.targetPositions,
    colors: buf.colors,
    lineKeys: buf.lineKeys,
    count: idx,
  }
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
// NOTE: this is a bit of an awkward artifact of the way the color conversion function was designed.
// ideally we would make this cleaner and ust use the value we want directly instead of having these
// rather unnecessary scaling factors, but they've been convenient for development/experimentation.
const HSL_CHANNELS = [
  { label: 'H', max: 360, scale: 1 },
  { label: 'S', max: 100, scale: 100 },
  { label: 'L', max: 100, scale: 100 },
] as const

// NOTE: certainly should be split up into 2-4 smaller components, but whatever.
function App() {
  const [darkMode, setDarkMode] = useState(true)

  // URL query-parameter-backed states
  const [zCutoffPercent, setZCutoffPercent] = useQueryState('zCutoff',
    parseAsInteger.withDefault(50)
  )
  const [gradients, setGradients] = useQueryState('gradients',
    gradientsStateParser.withDefault(DEFAULT_GRADIENTS)
  )

  // Editing states
  const [editingZCutoff, setEditingZCutoff] = useState(false)
  const [editingGradient, setEditingGradient] = useState<GradientKey | null>(null)

  const [zCutoffInput, setZCutoffInput] = useState('')
  const [highlightedEdges, setHighlightedEdges] = useState(new Set<string>())

  // State for the hover and pinned tooltip markers
  const [hoverInfo, setHoverInfo] = useState<HoverPoint | null>(null)
  const [pinnedInfo, setPinnedInfo] = useState<HoverPoint | null>(null)

  // Mesh data state.
  // TODO: would be nice to be able to dynamically load different mesh data sets.
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

  // A set of the original mesh vertices + z-cutoff intersection points for creating a
  // layer of hover target points
  const hoverVertices = useMemo(() => {
    const rows = X.length
    const cols = X[0].length
    const vertices: HoverVertex[] = []

    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        vertices.push({
          position: [X[j][i], Y[j][i], Z[j][i]],
          lineKeys: [`row-${j}`, `col-${i}`],
        })

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
              ],
              lineKeys: [`row-${j}`],
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
              ],
              lineKeys: [`col-${i}`],
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

  // A collection of buffers representing the graph wireframe, with colors and cutoffs calculated.
  const segmentBuffers = useMemo(
    () => fillSegmentBuffers(X, Y, Z, zCutoff, zMin, zMax, gradients),
    [X, Y, Z, zCutoff, zMin, zMax, gradients]
  )

  // Set of edges representing the graph axes, positioned at the edges of the bounding box.
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

  // set of edges representing the currently highlighted lines
  const highlightBuffers = useMemo(() => {
    if (highlightedEdges.size === 0) return null
    const src = segmentBuffers
    const indices: number[] = []
    for (let i = 0; i < src.count; i++) {
      if (highlightedEdges.has(src.lineKeys[i])) indices.push(i)
    }
    if (indices.length === 0) return null
    const n = indices.length
    const sp = new Float32Array(n * 3)
    const tp = new Float32Array(n * 3)
    const c = new Uint8ClampedArray(n * 4)
    for (let j = 0; j < n; j++) {
      const i = indices[j]
      const s3 = i * 3, d3 = j * 3
      sp[d3] = src.sourcePositions[s3]; sp[d3 + 1] = src.sourcePositions[s3 + 1]; sp[d3 + 2] = src.sourcePositions[s3 + 2]
      tp[d3] = src.targetPositions[s3]; tp[d3 + 1] = src.targetPositions[s3 + 1]; tp[d3 + 2] = src.targetPositions[s3 + 2]
      const s4 = i * 4, d4 = j * 4
      c[d4] = src.colors[s4]; c[d4 + 1] = src.colors[s4 + 1]; c[d4 + 2] = src.colors[s4 + 2]; c[d4 + 3] = src.colors[s4 + 3]
    }
    return { sourcePositions: sp, targetPositions: tp, colors: c, count: n }
  }, [segmentBuffers, highlightedEdges])

  // The set of Deck.gl layers to render
  const layers = [
    new LineLayer({
      id: 'wireframe',
      data: {
        length: segmentBuffers.count,
        attributes: {
          getSourcePosition: { value: segmentBuffers.sourcePositions, size: 3 },
          getTargetPosition: { value: segmentBuffers.targetPositions, size: 3 },
          getColor: { value: segmentBuffers.colors, size: 4 },
        },
      },
      getWidth: 1,
      widthUnits: 'pixels',
      updateTriggers: {
        getSourcePosition: [zCutoff],
        getTargetPosition: [zCutoff],
        getColor: [zCutoff, gradients],
      },
    }),
    ...(highlightBuffers ? [new LineLayer({
      id: 'wireframe-highlight',
      data: {
        length: highlightBuffers.count,
        attributes: {
          getSourcePosition: { value: highlightBuffers.sourcePositions, size: 3 },
          getTargetPosition: { value: highlightBuffers.targetPositions, size: 3 },
          getColor: { value: highlightBuffers.colors, size: 4 },
        },
      },
      getWidth: 4,
      widthUnits: 'pixels',
    })] : []),
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
        const isHighlighted = info.object.lineKeys.every(k => highlightedEdges.has(k))
        return (
          <div
            className={`tooltip ${pinnedInfo ? 'tooltip-pinned' : ''}`}
            style={{ left: info.x + 12, top: info.y - 12 }}
          >
            <div>X: {info.object.position[0].toFixed(3)}</div>
            <div>Y: {info.object.position[1].toFixed(3)}</div>
            <div>Z: {info.object.position[2].toFixed(3)}</div>
            {pinnedInfo && (
              <label className="highlight-toggle">
                <input
                  type="checkbox"
                  checked={isHighlighted}
                  onChange={(e) => {
                    setHighlightedEdges(prev => {
                      const next = new Set(prev)
                      for (const key of info.object.lineKeys) {
                        if (e.target.checked) next.add(key)
                        else next.delete(key)
                      }
                      return next
                    })
                  }}
                />
                Highlight
              </label>
            )}
          </div>
        )
      })()}
    </div>
  )
}

export default App
