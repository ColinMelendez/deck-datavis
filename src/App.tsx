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

interface LineSegment {
  sourcePosition: [number, number, number]
  targetPosition: [number, number, number]
  direction: 'x' | 'y'
}

interface AxisLine {
  sourcePosition: [number, number, number]
  targetPosition: [number, number, number]
  color: [number, number, number, number]
}

/**
 * Convert mesh data to line segments for wireframe rendering
 */
function meshToLineSegments(
  X: number[][],
  Y: number[][],
  Z: number[][]
): LineSegment[] {
  const segments: LineSegment[] = []
  const rows = Z.length
  const cols = Z[0].length

  // X-direction lines (horizontal in grid space)
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols - 1; i++) {
      segments.push({
        sourcePosition: [X[j][i], Y[j][i], Z[j][i]],
        targetPosition: [X[j][i + 1], Y[j][i + 1], Z[j][i + 1]],
        direction: 'x',
      })
    }
  }

  // Y-direction lines (vertical in grid space)
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols; i++) {
      segments.push({
        sourcePosition: [X[j][i], Y[j][i], Z[j][i]],
        targetPosition: [X[j + 1][i], Y[j + 1][i], Z[j + 1][i]],
        direction: 'y',
      })
    }
  }

  return segments
}

/**
 * Get color for a line segment based on direction and Z cutoff
 */
function getSegmentColor(
  segment: LineSegment,
  zCutoff: number
): [number, number, number, number] {
  // Use average Z of the segment for cutoff comparison
  const avgZ = (segment.sourcePosition[2] + segment.targetPosition[2]) / 2
  const isAbove = avgZ > zCutoff

  if (segment.direction === 'x') {
    return isAbove ? COLORS.xAbove : COLORS.xBelow
  } else {
    return isAbove ? COLORS.yAbove : COLORS.yBelow
  }
}

const INITIAL_VIEW_STATE: OrbitViewState = {
  target: [0, 0, 0],
  rotationX: 40,      // Elevation angle (looking down)
  rotationOrbit: -45, // Azimuth rotation
  zoom: 7,
  minZoom: 1,
  maxZoom: 10,
}

function App() {
  const [zCutoff, setZCutoff] = useState(0)

  // Generate mesh data once
  const { X, Y, Z, zMin, zMax } = useMemo(() => {
    const data = generateMeshData(-2, 2, -2, 2, 50) // Using 50x50 for performance

    // Calculate Z range for slider bounds
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

  // Convert to line segments once
  const lineSegments = useMemo(
    () => meshToLineSegments(X, Y, Z),
    [X, Y, Z]
  )

  // Create axis lines at the edges of the bounding box
  const axisLines: AxisLine[] = useMemo(() => {
    const xMin = -2, xMax = 2
    const yMin = -2, yMax = 2

    return [
      // X axis (red) - along the front edge at y=yMax, z=zMin
      {
        sourcePosition: [xMin, yMax, zMin],
        targetPosition: [xMax, yMax, zMin],
        color: COLORS.axisX,
      },
      // Y axis (green) - along the left edge at x=xMin, z=zMin
      {
        sourcePosition: [xMin, yMin, zMin],
        targetPosition: [xMin, yMax, zMin],
        color: COLORS.axisY,
      },
      // Z axis (cyan) - vertical at the back-left corner (xMin, yMin)
      {
        sourcePosition: [xMin, yMin, zMin],
        targetPosition: [xMin, yMin, zMax],
        color: COLORS.axisZ,
      },
    ]
  }, [zMin, zMax])

  // Create layers
  const layers = [
    // Wireframe surface
    new LineLayer<LineSegment>({
      id: 'wireframe',
      data: lineSegments,
      getSourcePosition: (d) => d.sourcePosition,
      getTargetPosition: (d) => d.targetPosition,
      getColor: (d) => getSegmentColor(d, zCutoff),
      getWidth: 1,
      widthUnits: 'pixels',
      updateTriggers: {
        getColor: [zCutoff],
      },
    }),
    // Coordinate axes
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

      {/* Controls overlay */}
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

      {/* Legend */}
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
