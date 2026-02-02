import { useState, useMemo } from 'react'
import DeckGL, { type OrbitViewState } from 'deck.gl'
import { LineLayer, OrbitView } from 'deck.gl'
import { generateMeshData } from './generate-mesh-data'
import './App.css'

// Color constants matching the build plan's semantic regions
const COLORS = {
  xBelow: [65, 105, 225, 255] as [number, number, number, number],    // Royal Blue
  xAbove: [135, 206, 250, 255] as [number, number, number, number],   // Light Sky Blue
  yBelow: [220, 20, 60, 255] as [number, number, number, number],     // Crimson
  yAbove: [255, 138, 5, 255] as [number, number, number, number],     // Orange
  // Axis colors
  axisX: [255, 80, 80, 255] as [number, number, number, number],      // Red
  axisY: [80, 200, 80, 255] as [number, number, number, number],      // Green
  axisZ: [80, 200, 255, 255] as [number, number, number, number],     // Cyan
}

interface ColoredSegment {
  sourcePosition: [number, number, number]
  targetPosition: [number, number, number]
  color: [number, number, number, number]
}

interface AxisLine {
  sourcePosition: [number, number, number]
  targetPosition: [number, number, number]
  color: [number, number, number, number]
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

/**
 * Convert mesh data to colored line segments, splitting at the Z cutoff plane.
 * This achieves pixel-accurate cutoff by subdividing segments that cross the plane.
 */
function meshToColoredSegments(
  X: number[][],
  Y: number[][],
  Z: number[][],
  zCutoff: number
): ColoredSegment[] {
  const segments: ColoredSegment[] = []
  const rows = Z.length
  const cols = Z[0].length

  const processSegment = (
    source: [number, number, number],
    target: [number, number, number],
    direction: 'x' | 'y'
  ) => {
    const sourceZ = source[2]
    const targetZ = target[2]
    const sourceAbove = sourceZ > zCutoff
    const targetAbove = targetZ > zCutoff

    const colorBelow = direction === 'x' ? COLORS.xBelow : COLORS.yBelow
    const colorAbove = direction === 'x' ? COLORS.xAbove : COLORS.yAbove

    if (sourceAbove === targetAbove) {
      // Entire segment is on one side of cutoff
      segments.push({
        sourcePosition: source,
        targetPosition: target,
        color: sourceAbove ? colorAbove : colorBelow,
      })
    } else {
      // Segment crosses the cutoff - split it
      const t = (zCutoff - sourceZ) / (targetZ - sourceZ)
      const midPoint = lerp3(source, target, t)

      // First half (from source to midpoint)
      segments.push({
        sourcePosition: source,
        targetPosition: midPoint,
        color: sourceAbove ? colorAbove : colorBelow,
      })

      // Second half (from midpoint to target)
      segments.push({
        sourcePosition: midPoint,
        targetPosition: target,
        color: targetAbove ? colorAbove : colorBelow,
      })
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

  // Create colored segments with cutoff splitting (recomputed when cutoff changes)
  const coloredSegments = useMemo(
    () => meshToColoredSegments(X, Y, Z, zCutoff),
    [X, Y, Z, zCutoff]
  )

  // Create axis lines at the edges of the bounding box
  const axisLines: AxisLine[] = useMemo(() => {
    const xMin = -2, xMax = 2
    const yMin = -2, yMax = 2

    return [
      {
        sourcePosition: [xMin, yMax, zMin],
        targetPosition: [xMax, yMax, zMin],
        color: COLORS.axisX,
      },
      {
        sourcePosition: [xMin, yMin, zMin],
        targetPosition: [xMin, yMax, zMin],
        color: COLORS.axisY,
      },
      {
        sourcePosition: [xMin, yMin, zMin],
        targetPosition: [xMin, yMin, zMax],
        color: COLORS.axisZ,
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
    <div className="app-container">
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
      </div>

      <div className="legend">
        <div className="legend-title">Axes</div>
        <div className="legend-item">
          <span className="legend-color" style={{ backgroundColor: `rgb(${COLORS.axisX.slice(0, 3).join(',')})` }} />
          X axis
        </div>
        <div className="legend-item">
          <span className="legend-color" style={{ backgroundColor: `rgb(${COLORS.axisY.slice(0, 3).join(',')})` }} />
          Y axis
        </div>
        <div className="legend-item">
          <span className="legend-color" style={{ backgroundColor: `rgb(${COLORS.axisZ.slice(0, 3).join(',')})` }} />
          Z axis
        </div>
        <div className="legend-title" style={{ marginTop: '12px' }}>Wireframe</div>
        <div className="legend-item">
          <span className="legend-color" style={{ backgroundColor: `rgb(${COLORS.xBelow.slice(0, 3).join(',')})` }} />
          X direction (below cutoff)
        </div>
        <div className="legend-item">
          <span className="legend-color" style={{ backgroundColor: `rgb(${COLORS.xAbove.slice(0, 3).join(',')})` }} />
          X direction (above cutoff)
        </div>
        <div className="legend-item">
          <span className="legend-color" style={{ backgroundColor: `rgb(${COLORS.yBelow.slice(0, 3).join(',')})` }} />
          Y direction (below cutoff)
        </div>
        <div className="legend-item">
          <span className="legend-color" style={{ backgroundColor: `rgb(${COLORS.yAbove.slice(0, 3).join(',')})` }} />
          Y direction (above cutoff)
        </div>
      </div>
    </div>
  )
}

export default App
