# Care Pathway — Caching & Partition Logic

This document explains how `src/services/turfService.js` caches work and how the
hospital→region partition is built. Read this before touching `solveCarePathway`,
`computeCell`, or any of the caches.

---

## Big picture

`solveCarePathway(hospitalsStr, roadsStr, subdistStr, settings, filterSig)` does, per call:

1. **Cluster** hospitals → centroids (metro regions merged to one point each; the rest via DBSCAN, `minPoints: 1`). Each centroid gets a `regionLabel` (metro name or `"dbscan"`) and an integer `_id` (its index).
2. **Voronoi** over the centroids (bbox = subdistrict bbox).
3. **Repair each cell** against the India boundary (clip → split → keep home piece → reassign orphans). This produces `regionsByCell: Map<cellId, { regionLabel, pieces: Feature<Polygon>[] }>`.
4. **Assign** every road segment and POI to a cell by point-in-polygon over the repaired regions (RBush-indexed), nearest-centroid as fallback.
5. **Route** each cell independently (`computeCell`): clip a subgraph from the cell's road segments, A* every POI to the centroid, dissolve to banded polylines.
6. Return `{ carepathway, voronoi (repaired regions), cells (catchment metadata) }`.

The expensive parts are **routing** (A* over thousands of POIs) and, secondarily,
**clipping + containment**. Caching exists to avoid redoing routing and clipping
when nothing relevant changed.

---

## Per-function cache bundles

Caches are **not shared between functions**. `CACHES` holds one bundle per function
(currently just `carepathway`), each `{ cellCache, clipCache, catchmentCache }`
created by `makeCaches()`. `buildPartition`/`routePartition` receive a bundle and
only ever touch that one, so switching functions never evicts or collides with
another's work. `solveCarePathway` passes `CACHES.carepathway`. The per-cell cache
key carries a `keyPrefix` (the function's `filterSig`) so additional functions can
be added with their own namespacing.

## The three caches (per bundle, persist across calls within a session)

### 1. `cellCache` — routed output per cell  ⭐ the important one
- **Key:** `` `${filterSig}|${regionLabel}|${regionHash(pieces)}` ``
  - `filterSig` — the active hospital-type filter (`[...visibleTypes].sort().join(',')`), passed from `map.jsx`. Derived from the **type checkboxes only**, NOT user-added hospitals — otherwise adding one point would change the key for every cell and nuke the cache.
  - `regionLabel` — metro name or `"dbscan"` (human-readable, stable for metro cells).
  - `regionHash(pieces)` — hash of the **repaired region geometry** (home piece + any absorbed orphans). `regionHash` = sorted per-piece `polygonHash`es joined; `polygonHash` uses `turf.coordAll` so it handles Polygon and MultiPolygon.
- **Value:** `{ features, bands }` — the dissolved banded LineString features for the cell, plus `{ master_id: bandIndex }` (routed-distance care band per POI, used to colour catchment subdistricts).
- **Why it's correct:** a cell's routes depend only on (its road slice + its POIs + its centroid), all of which are fixed once `filterSig` and the repaired region geometry are fixed. If the region polygon is byte-identical, the contained roads/POIs are identical, so the cached routes are valid.
- **Invalidation, automatic via the key:**
  - **Add/move/delete a hospital** → only regions whose geometry changed get new hashes → only those recompute; far-away regions are cache hits.
  - **Filter toggle** → `filterSig` changes → those cells recompute; toggling back reuses the prior entries.
  - **Edit a hospital's non-spatial properties** → clustering/geometry unchanged → full cache hit (instant).
- **Cap:** `CELL_CACHE_CAP = 2000`, LRU eviction.

### 2. `clipCache` — India-clipped pieces per Voronoi cell
- **Key:** `polygonHash(unclippedVoronoiCell)`.
- **Value:** `{ pieces: Feature<Polygon>[] }` — the result of `turf.intersect(cell, indiaBoundary)` flattened to individual polygons.
- **Why:** clipping ~400 cells against the (simplified) India outline every compute is costly. The unclipped Voronoi cell geometry is deterministic from the centroids, so on an incremental change most cells' unclipped geometry is unchanged → clip is reused, `turf.intersect` is skipped.
- **Cap:** `CLIP_CACHE_CAP = 2000`, LRU.
- **NOT cached:** the orphan-merge step and the road/POI containment assignment run **every** compute (they depend on neighbouring cells / the whole set, so they can't be memoised per cell cheaply). They're kept fast with RBush prefiltering. This is the main reason an incremental recompute is no longer ~160 ms but ~1–3 s.

### 3. `catchmentCache` — unioned subdistrict outline per cell
- **Key:** sorted `master_id` list of the cell's POIs, joined (`[...masterIds].sort().join(',')`).
- **Value:** `{ outline, subdistricts }` — the dissolved catchment polygon (buffer-out → union → buffer-in to close sliver gaps) plus the individual subdistrict polygons (with `subdistrict_name`).
- **Populated lazily** on hospital-marker click (`getCellCatchment`), not during `solveCarePathway`. Re-clicking the same cell is instant.

All three use the shared helpers `lruGet(map, key)` and `lruSet(map, key, val, cap)`.

---

## The India-clipped, orphan-repaired partition (step 3 in detail)

Why: India's coastline has deep concave cuts. Straight-line nearest-centroid
membership can assign a POI to a hospital only reachable across open water, so the
Voronoi boundary no longer means "closest reachable hospital." We fix membership
geometrically.

For each Voronoi cell (matched to its centroid by point-in-polygon):
1. **Clip to India** via `clipCellToIndia` (uses `clipCache`). Result may be one
   polygon or several disconnected pieces (`turf.flatten`).
2. **Home piece** = the piece containing the centroid (`booleanPointInPolygon`);
   if none (coastal centroid just outside the simplified border), the largest piece by `turf.area`.
3. **Orphans** = the other pieces, dropping slivers below `MIN_PIECE_AREA` (0.1 km²).
4. **Orphan merge (longest shared border):** for each orphan, RBush-prefilter nearby
   home pieces, then for each candidate sum the boundary overlap length
   (`turf.lineOverlap(orphanLine, candidateLine, { tolerance: OVERLAP_TOLERANCE })`
   → `turf.length`). The orphan joins the cell with the longest shared border
   (excluding its original cell). This is true adjacency across the India-internal edge.

Result: `regionsByCell`, where a cell's region = its home piece plus any orphans it absorbed.

### Assignment (step 4)
- Build an RBush over every region polygon (`{ bbox, poly, cellId }`).
- Each cell is also clipped to a `MAX_CELL_RADIUS_KM` (500 km) disk around its
  centroid before home/orphan selection, so sparse cells don't sprawl to the bbox edge.
- `assignCell(coord)`: query the RBush at the point, `booleanPointInPolygon` against
  candidates → `cellId`; fall back to `nearestCentroidId` **only if the nearest
  centroid is within `MAX_CELL_RADIUS_KM`**, otherwise the point is dropped (returns
  `null` and is skipped from routing/catchments — keeps the radius cap honest).
- Road segments are assigned by their **midpoint**; POIs by their coordinate.

---

## Tuning constants (top of `turfService.js`)

| Constant | Meaning | Trade-off |
|---|---|---|
| `BOUNDARY_TOLERANCE` (0.01°, ~1 km) | India outline simplification for clipping | Lower = captures finer concavities but slower `intersect` ×~400 cells |
| `MIN_PIECE_AREA` (1e5 m², 0.1 km²) | Orphan sliver cutoff | Higher drops real small pieces (their POIs fall back to nearest-centroid) |
| `OVERLAP_TOLERANCE` (0.001 km) | `lineOverlap` tolerance for shared-border length | Shared Voronoi edges are exact straight segments, so this can stay small |
| `MAX_CELL_RADIUS_KM` (500 km) | Caps each cell to a disk around its centroid | Lower = tighter catchments but more dropped points; raise to disable the cap effectively |
| `CELL_CACHE_CAP` / `CLIP_CACHE_CAP` (2000) | LRU caps | Memory vs hit rate across many filter/edit states |

---

## Gotchas / invariants

- **`filterSig` must come from `visibleTypes` only.** Never fold user-added hospitals
  into it — they're handled by the region-geometry hash, not the filter key.
- **Cache values are shared by reference.** Don't mutate a cached `features`/`outline`
  in place; build new objects (the React layers also key off `computeId` / catchment key).
- **`polygonHash` / `regionHash` must stay deterministic** (fixed coordinate precision,
  sorted piece order) or the `cellCache` will thrash.
- **Containment + orphan-merge are NOT cached.** If incremental recompute becomes too
  slow, the next optimisation is to memoise the assignment (e.g. cache `assignCell`
  results keyed by the set of region hashes) — but that's the only remaining global cost;
  routing (the historically dominant cost) is already cached.
- Geometry arrives from Supabase via `ST_AsGeoJSON(geom, 5)`; `fetchSpatial.js`'s
  `toFC` closes any open polygon rings (`closeGeometry`) so turf doesn't reject them.
