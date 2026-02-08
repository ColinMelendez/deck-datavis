# Design: Wireframe Surface Visualization

## What It Renders

A 3D wireframe surface rendered as a grid of colored line segments, viewed through an orbitable camera. The surface is derived from some 2D mesh data (`X[][]`, `Y[][]`, `Z[][]` — a regular grid of 3D vertices). The specifics of the data source are not important to this document; what matters is the shape: three parallel 2D arrays of equal dimensions where `(X[j][i], Y[j][i], Z[j][i])` gives the position of the vertex at grid row `j`, column `i`.

## Layer Architecture

The visualization is composed of five deck.gl layers, stacked in this order:

| Layer ID              | Type              | Purpose                                               |
|-----------------------|-------------------|-------------------------------------------------------|
| `wireframe`           | `LineLayer`       | The full surface wireframe — all colored segments     |
| `wireframe-highlight` | `LineLayer`       | Thickened re-draw of user-selected rows/columns       |
| `axes`                | `LineLayer`       | Three axis indicator lines at the bounding box corner |
| `mesh-vertices`       | `PointCloudLayer` | Invisible hit targets for hover/click picking         |
| `hover-marker`        | `PointCloudLayer` | Visible dot at the currently hovered or pinned vertex |

These are passed as a flat array to `<DeckGL layers={layers} />`. **The order is load-bearing** for two reasons:

1. **Draw order.** deck.gl renders layers in array index order. Later layers paint on top of earlier ones (before depth testing resolves ties). This is why `wireframe-highlight` follows `wireframe` — the 4px lines overdraw the 1px base. `axes` follows both so axis lines aren't occluded by surface edges at the bounding box corner. `hover-marker` is last and has `depthTest: false`, so it is unconditionally visible.
2. **Pick priority.** When multiple pickable layers overlap at the same screen pixel, deck.gl resolves the pick from the last layer first. Currently only `mesh-vertices` is pickable so this doesn't come into play, but the ordering would matter if any of the other layers gained `pickable: true`.

### The wireframe layer (`wireframe`)

This is the core visual. It receives its data as **binary attributes** — pre-filled typed arrays passed through `data.attributes` — rather than an array of JS objects with accessor functions. This distinction is the single most important performance decision in the file and is discussed in detail under [Segment Buffer Pipeline](#segment-buffer-pipeline).

The layer is configured with `updateTriggers` keyed on `zCutoff` and `gradients`. Because the underlying typed arrays are reused across renders (same `Float32Array` reference), deck.gl cannot detect content changes by reference comparison alone. The update triggers tell it "re-upload these attributes to the GPU whenever these values change."

### The highlight layer (`wireframe-highlight`)

A second `LineLayer` that re-renders a subset of the wireframe at a thicker width (4px vs 1px). It is conditionally included — the spread `...(highlightBuffers ? [...] : [])` keeps it out of the layer stack entirely when nothing is highlighted, avoiding any GPU work.

The highlight subset is materialized into its own small typed arrays by copying from the main segment buffers. This allocation is acceptable because it only happens on highlight toggle (a click event), not on slider drag.

### The pick layer (`mesh-vertices`)

An invisible `PointCloudLayer` with `getColor: [255, 255, 255, 0]` (fully transparent) and `pickable: true`. Its purpose is purely interactional: it provides the hit targets for deck.gl's picking system. Each point carries a `lineKeys` array identifying which row and column lines pass through it.

The data includes both the original mesh vertices _and_ synthetic points at z-cutoff crossings. The crossing points exist so the user can hover/click on the exact line where the color scheme changes — without them there would be a perceptible "dead zone" in picking near the cutoff plane.

`depthTest` is left at the default (`true`) for this layer. Since the points are invisible, depth-testing prevents them from occluding each other in pick resolution, which would cause incorrect hover targets on a 3D surface with self-overlap in screen space.

### The hover marker (`hover-marker`)

A visible `PointCloudLayer` with `depthTest: false` that draws a white dot at the hovered/pinned vertex. Depth testing is disabled so the dot is always visible, even when the vertex is geometrically behind another part of the surface from the current camera angle.

### The axes layer (`axes`)

Three `LineLayer` segments along the X, Y, and Z axes at the minimum corner of the bounding box. Uses standard object-based data (3 items), not binary attributes — the data is trivially small and static.

## Segment Buffer Pipeline

This is the hot path of the application. When the user drags the z-cutoff slider, `fillSegmentBuffers` is called on every frame. With a 100×100 grid subdivided 8× per edge, this produces roughly 160,000 line segments per invocation.

### The problem it solves

The naive implementation would create a JS object per segment:

```typescript
segments.push({
  sourcePosition: [x1, y1, z1],
  targetPosition: [x2, y2, z2],
  color: [r, g, b, a],
  lineKey: "row-5",
})
```

At 160K segments, that means 160K objects, 320K position tuples, 160K color tuples, and 160K template-literal strings — all created and immediately eligible for GC. During continuous slider drag this produced visible frame drops.

### The solution: Structure-of-Arrays with binary attributes

Instead of an Array of Structures (one object per segment), the data is stored as a Structure of Arrays:

```typescript
interface SegmentBuffers {
  sourcePositions: Float32Array   // 3 floats per segment, contiguous
  targetPositions: Float32Array   // 3 floats per segment, contiguous
  colors: Uint8ClampedArray       // 4 bytes per segment, contiguous
  lineKeys: string[]              // parallel array of interned strings
  count: number                   // how many segments are actually used
}
```

The typed arrays are **pre-allocated to worst-case capacity** (every edge crossing the cutoff, doubled, times subdivisions) at the module level and **reused across renders**. The `getSegmentBuffers(capacity)` function grows them lazily if needed but never shrinks — exactly the same pattern as a bump allocator.

On each invocation, `fillSegmentBuffers` writes directly into these arrays using index arithmetic:

```typescript
const sOff = idx * 3
buf.sourcePositions[sOff]     = p1x
buf.sourcePositions[sOff + 1] = p1y
buf.sourcePositions[sOff + 2] = p1z
```

No intermediate objects, tuples, or closures are created.

### Additional allocation avoidance

- **HSL interpolation** writes into a module-level `_tempHsl` buffer instead of returning a new `[h, s, l, a]` tuple.
- **RGB conversion** writes into a module-level `_tempRgb` buffer, then the 4 bytes are copied into the `Uint8ClampedArray`.
- **3D point interpolation** (subdivision) is done with scalar variables (`sx + dx * t1`) rather than `lerp3()` which would allocate a `[number, number, number]` per call.
- **Line key strings** (`"row-0"`, `"col-5"`, etc.) are interned: created once on first use and cached in `_rowKeys[]` / `_colKeys[]`, so the same string reference is reused across all recomputations.

### React memo integration

Since the typed arrays are reused (same JS reference), `useMemo` downstream would not detect changes. The function returns a **new plain object wrapper** on each call:

```typescript
return {
  sourcePositions: buf.sourcePositions,   // same Float32Array
  targetPositions: buf.targetPositions,
  colors: buf.colors,
  lineKeys: buf.lineKeys,
  count: idx,                              // may differ
}
```

This gives React a new reference to trigger dependent memos (like `highlightBuffers`), while the typed arrays themselves are reused.

On the deck.gl side, because the `Float32Array` references never change, `updateTriggers` are necessary to tell deck.gl to re-upload the data to the GPU.

## The Z-Cutoff Plane

The z-cutoff is the central interactive parameter. It defines a horizontal plane at some Z value that divides the surface into "above" and "below" regions, each colored with a different gradient.

### How it splits segments

In `processEdge`, each mesh edge is classified:

1. **Both endpoints on the same side** → subdivide normally with one gradient.
2. **Endpoints on opposite sides** → compute the exact crossing point via linear interpolation (`f = (zCutoff - sz) / (tz - sz)`), then subdivide each half separately with its own gradient.

This means the color transition is always _exact_ at the cutoff plane, not approximated to the nearest mesh vertex.

### Subdivision for smooth gradients

Each mesh edge (or half-edge, if split at the cutoff) is further divided into `GRADIENT_SUBDIVISIONS` (8) sub-segments. Each sub-segment is colored based on its midpoint Z value interpolated through the gradient. This creates visually smooth color variation along each line, rather than having each mesh edge be a single flat color.

## Color System

### Gradient model

Four gradients are defined, one per combination of direction (X vs Y) and cutoff side (above vs below):

| Key      | Meaning                            |
|----------|------------------------------------|
| `xBelow` | X-direction lines below the cutoff |
| `xAbove` | X-direction lines above the cutoff |
| `yBelow` | Y-direction lines below the cutoff |
| `yAbove` | Y-direction lines above the cutoff |

Each gradient has a `low` and `high` endpoint in HSL space (`[h, s, l, alpha]`). The interpolation parameter `t` is the segment's normalized Z position within the global `[zMin, zMax]` range. So "low" colors appear at the bottom of the surface and "high" colors at the top, with smooth blending in between.

### HSL representation

Colors are stored and interpolated in HSL in the component's logic, then converted to 8-bit RGB integers for deck.gl. The HSL buffers use the convention `[h, s, l, a]` where H is 0–360 and S/L are 0–1. Alpha is 0–255 (though we just keep it opaque through all operations). The conversion happens via `hslToRgbBuff` from `color-utils.ts`, which writes into a caller-provided output buffer.

## Interaction Model

### Hover

The `mesh-vertices` PointCloudLayer fires `onHover` callbacks. When the cursor is over a point, `hoverInfo` is set with the screen coordinates and the `HoverVertex` data (3D position + associated line keys). The tooltip renders at the cursor position showing X/Y/Z coordinates.

### Pin (click)

Clicking a point sets `pinnedInfo`, which persists the tooltip even when the cursor moves away. The pinned tooltip gains `pointer-events: auto` (via CSS class `tooltip-pinned`) so it can receive interactions — specifically, the highlight checkbox.

Clicking empty space (detected by the top-level `DeckGL onClick` when `info.object` is falsy) clears the pin.

### Highlight

The pinned tooltip includes a checkbox. When checked, the vertex's `lineKeys` are added to the `highlightedEdges` Set. This triggers the `highlightBuffers` memo, which extracts matching segments from the main buffer and creates the thickened highlight layer.

A vertex at grid position `(j, i)` has keys `["row-j", "col-i"]`, so highlighting it visually emphasizes the full row and column lines that intersect at that point.

## State and URL Persistence

Two pieces of state are persisted in the URL query string via `nuqs` (`useQueryState`):

- **`zCutoff`** — integer 0–100 representing the cutoff as a percentage of the Z range.
- **`gradients`** — the full `GradientState` object, JSON-serialized. A custom `createParser` handles validation on parse (checking that all four keys exist with valid 4-element numeric arrays).

This means a specific view configuration can be shared as a URL. All other state (hover, pin, highlight, dark mode, camera) is ephemeral.

## View Configuration

The scene uses a single `OrbitView` with `orbitAxis: 'Z'`, meaning the camera orbits around the Z axis. The initial view state places the camera at 40° elevation and -45° orbit angle, zoomed to level 7. Zoom is clamped to `[6, 12]`.

deck.gl's built-in controller handles mouse/touch interaction for rotation, zoom, and pan. No custom controller logic is needed.
