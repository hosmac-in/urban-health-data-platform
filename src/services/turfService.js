import * as turf from '@turf/turf';
import RBush from 'rbush';
import createGraph from 'ngraph.graph';
import { aStar } from 'ngraph.path';
import { fetchMetroRegions, fetchIndiaBoundary, fetchSubdistrictBoundaries } from '../lib/fetchSpatial';

const DEFAULT_CLUSTER_RADIUS = 0.4;
const DEFAULT_SEARCH_RADIUS = 0.1;

// India-clipped Voronoi repair tuning.
const BOUNDARY_TOLERANCE = 0.01;   // deg (~1km) — India outline simplification for clipping
const MIN_PIECE_AREA     = 1e5;    // m² (0.1 km²) — ignore clip slivers smaller than this as orphans
const OVERLAP_TOLERANCE  = 0.001;  // km — turf.lineOverlap tolerance for shared-border length
const MAX_CELL_RADIUS_KM = 500;    // km — cap each Voronoi cell to a disk of this radius around its centroid
const ROUTING_BUFFER_KM  = 50;     // km — grow each cell's region by this much when collecting roads to route with (connectivity only; POI/cell membership stays unbuffered)

const careBands = [
    { upTo: 50,       color: '#3700ff', weight: 6 },
    { upTo: 100,      color: '#00b93e', weight: 5 },
    { upTo: 200,      color: '#ffa600', weight: 4 },
    { upTo: Infinity, color: '#7c0d0d', weight: 3 },
];

function mergeToPoint(features) {
    return turf.centroid(turf.featureCollection(features));
}

// ── Per-function caches (nothing shared between functions) ───────────────────
// Each analysis function gets its own bundle so switching functions never evicts
// or collides with another's cached work.
//   cellCache    — cellSig (`${filterSig}|${regionLabel}|${polygonHash}`) -> { features, bands }
//   clipCache    — unclipped cell hash -> { pieces: Polygon[] }
//   catchmentCache — sorted master_id list -> { outline, subdistricts, areaKm2 }
const CELL_CACHE_CAP = 2000;
const CLIP_CACHE_CAP = 2000;
function makeCaches() {
    return { cellCache: new Map(), clipCache: new Map(), catchmentCache: new Map() };
}
const CACHES = {
    carepathway: makeCaches(),
};

function lruGet(map, key) {
    if (!map.has(key)) return undefined;
    const v = map.get(key);
    map.delete(key);   // LRU: re-insert as most-recently-used
    map.set(key, v);
    return v;
}

function lruSet(map, key, v, cap) {
    map.set(key, v);
    if (map.size > cap) {
        map.delete(map.keys().next().value); // evict oldest
    }
}

// India national outline, fetched once and simplified for fast Voronoi clipping.
let indiaBoundary = null;
async function ensureIndiaBoundary() {
    if (indiaBoundary) return indiaBoundary;
    let b = await fetchIndiaBoundary();
    if (b && b.type === 'FeatureCollection') {
        b = b.features.length === 1 ? b.features[0] : turf.union(turf.featureCollection(b.features));
    }
    try {
        b = turf.simplify(b, { tolerance: BOUNDARY_TOLERANCE, highQuality: false, mutate: true });
    } catch (e) {
        // console.warn('[turf] india boundary simplify failed:', e?.message);
    }
    indiaBoundary = b;
    return indiaBoundary;
}

function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
}

// Hash any Polygon/MultiPolygon feature or geometry by all its coordinates.
function polygonHash(featureOrGeom) {
    const coords = turf.coordAll(featureOrGeom);
    let s = '';
    for (const c of coords) s += c[0].toFixed(6) + ',' + c[1].toFixed(6) + ';';
    return hashStr(s);
}

// Stable hash for a repaired region (one or more polygon pieces).
function regionHash(pieces) {
    return pieces.map((p) => polygonHash(p)).sort().join('|');
}

// ── Road segment index (built once per session) ──────────────────────────────
let roadTree = null;       // RBush over segment bboxes (reserved for future use)
let roadSig = null;
let roadSegments = null;    // array of [ [x,y], [x,y] ] coordinate pairs

function ensureRoadIndex(roadFC) {
    const first = roadFC.features[0]?.geometry?.coordinates?.[0];
    const sig = roadFC.features.length + ':' + (Array.isArray(first) ? first.join(',') : '');
    if (roadSegments && roadSig === sig) return;
    roadSig = sig;

    const segs = [];
    const items = [];
    roadFC.features.forEach((road) => {
        const coords = road.geometry.coordinates;
        for (let i = 0; i < coords.length - 1; i++) {
            const a = coords[i], b = coords[i + 1];
            items.push({
                minX: Math.min(a[0], b[0]), minY: Math.min(a[1], b[1]),
                maxX: Math.max(a[0], b[0]), maxY: Math.max(a[1], b[1]),
                idx: segs.length,
            });
            segs.push([a, b]);
        }
    });
    roadSegments = segs;
    roadTree = new RBush();
    roadTree.load(items);
}

// ── Dissolve routes into deduplicated, banded, chained polylines ─────────────
function dissolveRoutes(routeLines) {
    const edgeBandMap = new Map();
    routeLines.forEach((route) => {
        const coords = route.geometry.coordinates;
        let cumDist = 0;
        for (let i = 0; i < coords.length - 1; i++) {
            const segDist   = turf.distance(turf.point(coords[i]), turf.point(coords[i + 1]));
            const bandIndex = careBands.findIndex((b) => cumDist < b.upTo);
            const edgeKey   = [coords[i].join(','), coords[i + 1].join(',')].sort().join('|');
            if (!edgeBandMap.has(edgeKey) || bandIndex < edgeBandMap.get(edgeKey).bandIndex) {
                edgeBandMap.set(edgeKey, { bandIndex, coordA: coords[i], coordB: coords[i + 1] });
            }
            cumDist += segDist;
        }
    });

    // Group edges by band, then chain adjacent degree-2 edges into longer polylines.
    const byBand = new Map();
    edgeBandMap.forEach(({ bandIndex, coordA, coordB }) => {
        if (!byBand.has(bandIndex)) byBand.set(bandIndex, []);
        byBand.get(bandIndex).push([coordA, coordB]);
    });

    const dissolvedSegments = [];
    const ek = (a, b) => (a < b ? `${a}§${b}` : `${b}§${a}`);

    byBand.forEach((edges, bandIndex) => {
        const band = careBands[bandIndex];
        const adj      = new Map();
        const coordMap = new Map();
        const usedEdge = new Set();

        edges.forEach(([a, b]) => {
            const ak = a.join(','), bk = b.join(',');
            coordMap.set(ak, a); coordMap.set(bk, b);
            if (!adj.has(ak)) adj.set(ak, new Set());
            if (!adj.has(bk)) adj.set(bk, new Set());
            adj.get(ak).add(bk);
            adj.get(bk).add(ak);
        });

        adj.forEach((_, startKey) => {
            adj.get(startKey).forEach((neighborKey) => {
                const key = ek(startKey, neighborKey);
                if (usedEdge.has(key)) return;
                usedEdge.add(key);

                const chain = [coordMap.get(startKey), coordMap.get(neighborKey)];
                let curr = neighborKey;
                while (true) {
                    const nexts = [...(adj.get(curr) || [])].filter((n) => !usedEdge.has(ek(curr, n)));
                    if (nexts.length !== 1) break;
                    const next = nexts[0];
                    usedEdge.add(ek(curr, next));
                    chain.push(coordMap.get(next));
                    curr = next;
                }

                dissolvedSegments.push(turf.lineString(chain, {
                    careColor:      band.color,
                    careLineWeight: band.weight,
                    careBand:       bandIndex,
                }));
            });
        });
    });

    return dissolvedSegments;
}

// ── Route one cell: build a subgraph from its road slice, snap the hospital onto
//    that graph, A* every POI to the hospital, dissolve to banded polylines.
//    Routing only — no straight-line distance is ever used for banding. POIs that
//    can't be routed are dropped (reported via `routedMasterIds`). Self-contained.
function computeCell(cellSegs, centroid, poisInCell, searchRadius) {
    const bands = {};             // master_id -> care band index (routed distance only)
    const routedMasterIds = [];   // master_ids whose POI successfully routed to the hospital
    const empty = { features: [], bands, routedMasterIds };

    // No roads or no POIs ⇒ nothing routable.
    if (poisInCell.length === 0 || cellSegs.length === 0) return empty;

    const graph = createGraph();
    cellSegs.forEach(([a, b]) => {
        const ak = a.join(','), bk = b.join(',');
        const weight = turf.distance(turf.point(a), turf.point(b));
        graph.addLink(ak, bk, { weight });
        graph.addLink(bk, ak, { weight });
    });

    const nodeItems = [];
    graph.forEachNode((n) => {
        const [x, y] = n.id.split(',').map(Number);
        nodeItems.push({ minX: x, minY: y, maxX: x, maxY: y, id: n.id });
    });
    if (nodeItems.length === 0) return empty;
    const nodeTree = new RBush();
    nodeTree.load(nodeItems);

    function nearestNodeId(coord) {
        const [px, py] = coord;
        const r = searchRadius;
        const candidates = nodeTree.search({ minX: px - r, minY: py - r, maxX: px + r, maxY: py + r });
        if (!candidates.length) return null;
        let best = null, minD = Infinity;
        candidates.forEach((c) => {
            const dx = c.id.split(',')[0] - px;
            const dy = c.id.split(',')[1] - py;
            const d = dx * dx + dy * dy;
            if (d < minD) { minD = d; best = c.id; }
        });
        return best;
    }

    // Snap the hospital (cell centroid) onto the road network: find the nearest road
    // node (unbounded), add a new node at the hospital + a connector segment to it, so
    // the hospital is always a reachable routing target. Routes terminate here.
    const centroidCoord = centroid.geometry.coordinates;
    let nearId = null, nearMinD = Infinity;
    for (const it of nodeItems) {
        const dx = it.minX - centroidCoord[0], dy = it.minY - centroidCoord[1];
        const d = dx * dx + dy * dy;
        if (d < nearMinD) { nearMinD = d; nearId = it.id; }
    }
    if (!nearId) return empty;
    const toId = centroidCoord.join(',');
    const connW = turf.distance(turf.point(centroidCoord), turf.point(nearId.split(',').map(Number)));
    graph.addLink(toId, nearId, { weight: connW });
    graph.addLink(nearId, toId, { weight: connW });

    const pathFinder = aStar(graph, {
        distance: (_, __, link) => link.data.weight,
        heuristic: (from, to) => {
            const [fx, fy] = from.id.split(',').map(Number);
            const [tx, ty] = to.id.split(',').map(Number);
            return turf.distance(turf.point([fx, fy]), turf.point([tx, ty]));
        },
    });

    const routeLines = [];
    poisInCell.forEach((poi) => {
        const mid = poi.properties.master_id;
        const fromId = nearestNodeId(poi.geometry.coordinates);
        if (!fromId) return;                          // unroutable POI → excluded
        const result = pathFinder.find(fromId, toId);
        if (!result || result.length < 2) return;     // routing failed → excluded
        const coords = result.map((node) => node.id.split(',').map(Number));
        const routed = turf.lineString(coords, { ...poi.properties });
        routeLines.push(routed);
        const distKm = turf.length(routed, { units: 'kilometers' });
        if (mid) {
            bands[mid] = careBands.findIndex((b) => distKm < b.upTo);
            routedMasterIds.push(mid);
        }
    });

    return { features: dissolveRoutes(routeLines), bands, routedMasterIds };
}

// ── Partition builder ────────────────────────────────────────────────────────
// Cluster a set of hospital features → Voronoi → India-clip → 500km cap → orphan
// repair, and return the repaired regions plus an `assignCell` lookup. Shared by
// each analysis function (currently Care Pathways uses one partition).
function buildPartition(hospitalFeatures, metroRegions, subdistBbox, boundary, settings, caches) {
    const CLUSTER_RADIUS = settings.clusterRadius ?? DEFAULT_CLUSTER_RADIUS;

    // --- Hospital clustering ---
    // Merge all hospitals within each metro region into a single centroid.
    // Remaining hospitals (outside all metro regions) go through DBSCAN.
    const mergedPoints = [];
    const assignedIdxSet = new Set();

    metroRegions.features.forEach((regionFeature) => {
        const inRegion = hospitalFeatures
            .map((h, i) => ({ h, i }))
            .filter(({ h }) => turf.booleanPointInPolygon(h, regionFeature));
        if (inRegion.length === 0) return;
        inRegion.forEach(({ i }) => assignedIdxSet.add(i));
        const c = mergeToPoint(inRegion.map(({ h }) => h));
        c.properties.regionLabel = regionFeature.properties?.name ?? 'metro';
        mergedPoints.push(c);
    });

    const otherHospitals = hospitalFeatures.filter((_, i) => !assignedIdxSet.has(i));

    if (otherHospitals.length > 0) {
        const clustered = turf.clustersDbscan(
            turf.featureCollection(otherHospitals),
            CLUSTER_RADIUS,
            { units: 'kilometers', minPoints: 1 }
        );
        const clusterMap = new Map();
        clustered.features.forEach((f, i) => {
            const key = f.properties.dbscan === 'noise' ? `noise_${i}` : `cluster_${f.properties.cluster}`;
            if (!clusterMap.has(key)) clusterMap.set(key, []);
            clusterMap.get(key).push(f);
        });
        clusterMap.forEach((pts) => {
            const c = mergeToPoint(pts);
            c.properties.regionLabel = 'dbscan';
            mergedPoints.push(c);
        });
    }

    const mergedHospitals = turf.featureCollection(mergedPoints);
    mergedHospitals.features.forEach((f, i) => { f.properties._id = i; });
    const centroids = mergedHospitals.features;
    // console.log('[turf] clustering — metro used:', assignedIdxSet.size, 'other:', otherHospitals.length, 'merged total:', centroids.length);

    if (centroids.length === 0) {
        return { centroids: [], regionsByCell: new Map(), voronoiOut: turf.featureCollection([]), assignCell: () => null };
    }

    // --- Voronoi → India-clipped, orphan-repaired regions ---
    const voronoiHospital = turf.voronoi(mergedHospitals, { bbox: subdistBbox });

    function nearestCentroidId(coord) {
        let best = -1, min = Infinity;
        for (const c of centroids) {
            const dx = c.geometry.coordinates[0] - coord[0];
            const dy = c.geometry.coordinates[1] - coord[1];
            const d = dx * dx + dy * dy;
            if (d < min) { min = d; best = c.properties._id; }
        }
        return best;
    }

    // Clip one Voronoi cell to India → its polygon pieces (cached by unclipped hash).
    function clipCellToIndia(poly) {
        const key = polygonHash(poly);
        const hit = lruGet(caches.clipCache, key);
        if (hit) return hit.pieces;
        let pieces = [];
        if (boundary) {
            try {
                const inter = turf.intersect(turf.featureCollection([poly, boundary]));
                if (inter) pieces = turf.flatten(inter).features;
            } catch (e) { /* leave empty on failure */ }
        }
        if (pieces.length === 0) pieces = turf.flatten(poly).features; // fallback: unclipped
        lruSet(caches.clipCache, key, { pieces }, CLIP_CACHE_CAP);
        return pieces;
    }

    // Home piece (contains centroid) + orphan pieces per cell.
    const homePieces = []; // { cellId, regionLabel, poly }
    const orphans = [];    // { fromCellId, poly }
    voronoiHospital.features.forEach((poly) => {
        if (!poly) return;
        const match = centroids.find((pt) => turf.booleanPointInPolygon(pt, poly));
        if (!match) return;
        const cellId = match.properties._id;
        const regionLabel = match.properties.regionLabel ?? 'cell';
        const pieces = clipCellToIndia(poly);
        if (pieces.length === 0) return;

        // Cap the cell to a 500 km disk around its centroid so sparse cells don't sprawl.
        const disk = turf.circle(match.geometry.coordinates, MAX_CELL_RADIUS_KM, { units: 'kilometers', steps: 64 });
        const capped = [];
        for (const pc of pieces) {
            try {
                const clipped = turf.intersect(turf.featureCollection([pc, disk]));
                if (clipped) capped.push(...turf.flatten(clipped).features);
            } catch { /* skip degenerate piece */ }
        }
        if (capped.length === 0) return;

        let home = capped.find((pc) => turf.booleanPointInPolygon(match, pc));
        if (!home) home = capped.reduce((a, b) => (turf.area(a) >= turf.area(b) ? a : b));
        homePieces.push({ cellId, regionLabel, poly: home });
        capped.forEach((pc) => {
            if (pc === home) return;
            if (turf.area(pc) < MIN_PIECE_AREA) return; // ignore clip slivers
            orphans.push({ fromCellId: cellId, poly: pc });
        });
    });

    const regionsByCell = new Map(); // cellId -> { regionLabel, pieces: Feature<Polygon>[] }
    homePieces.forEach(({ cellId, regionLabel, poly }) => {
        regionsByCell.set(cellId, { regionLabel, pieces: [poly] });
    });

    // Merge each orphan into the home piece it shares the longest border with.
    const homeTree = new RBush();
    homePieces.forEach((hp, i) => {
        const [minX, minY, maxX, maxY] = turf.bbox(hp.poly);
        homeTree.insert({ minX, minY, maxX, maxY, i });
    });
    orphans.forEach(({ fromCellId, poly }) => {
        const [minX, minY, maxX, maxY] = turf.bbox(poly);
        const cand = homeTree.search({ minX, minY, maxX, maxY });
        const orphanLine = turf.polygonToLine(poly);
        let bestId = -1, bestLen = -1;
        cand.forEach(({ i }) => {
            const hp = homePieces[i];
            if (hp.cellId === fromCellId) return; // must move to another cell
            let len = 0;
            try {
                const ov = turf.lineOverlap(orphanLine, turf.polygonToLine(hp.poly), { tolerance: OVERLAP_TOLERANCE });
                ov.features.forEach((f) => { len += turf.length(f, { units: 'kilometers' }); });
            } catch (e) { /* ignore */ }
            if (len > bestLen) { bestLen = len; bestId = hp.cellId; }
        });
        const target = bestId !== -1 && bestLen > 0 ? bestId : fromCellId;
        regionsByCell.get(target)?.pieces.push(poly);
    });

    // --- assignCell: containment in the repaired regions, range-bounded fallback ---
    const regionTree = new RBush();
    regionsByCell.forEach((reg, cellId) => {
        reg.pieces.forEach((poly) => {
            const [minX, minY, maxX, maxY] = turf.bbox(poly);
            regionTree.insert({ minX, minY, maxX, maxY, poly, cellId });
        });
    });

    function assignCell(coord) {
        const pt = turf.point(coord);
        const cand = regionTree.search({ minX: coord[0], minY: coord[1], maxX: coord[0], maxY: coord[1] });
        for (const c of cand) {
            if (turf.booleanPointInPolygon(pt, c.poly)) return c.cellId;
        }
        // No containing region: only fall back if within the radius cap, else drop.
        const id = nearestCentroidId(coord);
        if (id === -1) return null;
        const d = turf.distance(turf.point(centroids[id].geometry.coordinates), pt, { units: 'kilometers' });
        return d <= MAX_CELL_RADIUS_KM ? id : null;
    }

    // Repaired regions for the overlay / catchment (already India-clipped).
    const voronoiOut = turf.featureCollection(
        [...regionsByCell.entries()].flatMap(([cellId, reg]) =>
            reg.pieces.map((poly) => turf.feature(poly.geometry, { _cellId: cellId, regionLabel: reg.regionLabel }))
        )
    );

    return { centroids, regionsByCell, voronoiOut, assignCell };
}

// ── Route a partition: assign roads + POIs to its cells, then route each cell ──
// `keyPrefix` namespaces the per-cell cache. Returns the dissolved features plus
// per-cell POI bands/membership.
function routePartition(part, poiFeatures, settings, caches, keyPrefix) {
    const SEARCH_RADIUS = settings.searchRadius ?? DEFAULT_SEARCH_RADIUS;
    const { centroids, regionsByCell, assignCell } = part;

    // Each cell routes against roads within ROUTING_BUFFER_KM of its region (not just the
    // roads strictly inside it) so a thin in-cell road slice can't strand reachable POIs.
    // This affects connectivity only — POI→cell membership below stays unbuffered.
    const ROUTING_BUFFER = settings.routingBufferKm ?? ROUTING_BUFFER_KM;
    const bufCells = []; // { cellId, feats: Feature<Polygon>[] }
    const bufCellTree = new RBush();
    regionsByCell.forEach((reg, cellId) => {
        const fc = turf.featureCollection(reg.pieces.map((p) => turf.feature(p.geometry)));
        let buffered = null;
        try { buffered = turf.buffer(fc, ROUTING_BUFFER, { units: 'kilometers' }); } catch { /* fall back */ }
        const feats = (buffered?.features?.length ? buffered.features : fc.features).filter((f) => f && f.geometry);
        if (feats.length === 0) return;
        const entryIdx = bufCells.length;
        bufCells.push({ cellId, feats });
        feats.forEach((f) => {
            const [minX, minY, maxX, maxY] = turf.bbox(f);
            bufCellTree.insert({ minX, minY, maxX, maxY, entryIdx });
        });
    });

    const segsByCell = new Map();
    regionsByCell.forEach((_, cellId) => segsByCell.set(cellId, []));
    roadSegments.forEach((seg) => {
        const mx = (seg[0][0] + seg[1][0]) / 2;
        const my = (seg[0][1] + seg[1][1]) / 2;
        const pt = turf.point([mx, my]);
        const hits = bufCellTree.search({ minX: mx, minY: my, maxX: mx, maxY: my });
        const added = new Set();
        for (const { entryIdx } of hits) {
            const { cellId, feats } = bufCells[entryIdx];
            if (added.has(cellId)) continue;
            if (feats.some((f) => turf.booleanPointInPolygon(pt, f))) {
                segsByCell.get(cellId).push(seg);
                added.add(cellId);
            }
        }
    });

    const poisByCell = new Map();
    poiFeatures.forEach((poi) => {
        const id = assignCell(poi.geometry.coordinates);
        if (id == null) return;
        if (!poisByCell.has(id)) poisByCell.set(id, []);
        poisByCell.get(id).push(poi);
    });

    const allFeatures = [];
    const cellBandsById = {};
    const routedMidsById = {}; // cellId -> master_ids that successfully routed
    let total = 0, cached = 0, recomputed = 0;
    regionsByCell.forEach((reg, cellId) => {
        total++;
        const cellSig = `${keyPrefix}${reg.regionLabel}|${regionHash(reg.pieces)}`;
        let cellData = lruGet(caches.cellCache, cellSig);
        if (cellData) {
            cached++;
        } else {
            cellData = computeCell(
                segsByCell.get(cellId) || [],
                centroids[cellId],
                poisByCell.get(cellId) || [],
                SEARCH_RADIUS
            );
            lruSet(caches.cellCache, cellSig, cellData, CELL_CACHE_CAP);
            recomputed++;
        }
        for (const f of cellData.features) {
            f.properties._cellId = cellId; // tag for per-cell hover colouring in the UI
            allFeatures.push(f);
        }
        cellBandsById[cellId] = cellData.bands;
        routedMidsById[cellId] = cellData.routedMasterIds || [];
    });
    // console.log(`[turf] ${keyPrefix}cells — total:`, total, 'cached:', cached, 'recomputed:', recomputed);

    return { features: allFeatures, cellBandsById, poisByCell, routedMidsById };
}

export async function solveCarePathway(hospitalsStr, roadsStr, subdistStr, settings = {}, filterSig = '') {
    const inputHospital = JSON.parse(hospitalsStr);
    const inputRoad     = JSON.parse(roadsStr);
    const inputSubdist  = JSON.parse(subdistStr);

    // console.log('[turf] inputs — hospitals:', inputHospital.features.length, 'roads:', inputRoad.features.length, 'subdist:', inputSubdist.features.length);

    const metroRegions = await fetchMetroRegions();
    const boundary = await ensureIndiaBoundary();
    ensureRoadIndex(inputRoad);

    if (inputSubdist.features.length === 0) {
        // console.warn('[turf] WARNING: 0 subdistrict POI points — check poi_subdistricts_view');
    }
    const subdistBbox = turf.bbox(inputSubdist);
    const caches = CACHES.carepathway;

    const part = buildPartition(inputHospital.features, metroRegions, subdistBbox, boundary, settings, caches);
    if (part.centroids.length === 0) return { carepathway: turf.featureCollection([]) };

    // console.time('routing');
    const { features, cellBandsById, routedMidsById } = routePartition(part, inputSubdist.features, settings, caches, `${filterSig}|`);
    // console.timeEnd('routing');

    // A cell's catchment is only the subdistricts that successfully routed to its
    // hospital — unroutable subdistricts are excluded (no straight-line fallback).
    const cells = part.centroids.map((c) => {
        const id = c.properties._id;
        return {
            centroid: c.geometry.coordinates,
            masterIds: (routedMidsById[id] || []).filter(Boolean),
            bands: cellBandsById[id] || {},
        };
    });

    return { carepathway: turf.featureCollection(features), voronoi: part.voronoiOut, cells };
}

// ── Catchment: union of a cell's subdistrict boundaries (cached by master_id set) ──
// Returns { outline, subdistricts }: the dissolved boundary + the individual polygons.
const CATCHMENT_OFFSET = 0.05; // km — buffer out/in to close sliver gaps between non-matching borders
const catchmentCache = CACHES.carepathway.catchmentCache;
export async function getCellCatchment(masterIds) {
    const key = [...masterIds].sort().join(',');
    if (catchmentCache.has(key)) return catchmentCache.get(key);

    const fc = await fetchSubdistrictBoundaries(masterIds);
    let outline;
    if (fc.features.length === 0) {
        outline = turf.featureCollection([]);
    } else if (fc.features.length === 1) {
        outline = turf.featureCollection([fc.features[0]]);
    } else {
        try {
            // Offset each boundary out, union (so adjacent ones overlap cleanly), then offset back.
            const buffered = turf.buffer(turf.featureCollection(fc.features), CATCHMENT_OFFSET, { units: 'kilometers' });
            const valid = buffered.features.filter((f) => f && f.geometry);
            let u = turf.union(turf.featureCollection(valid));
            const shrunk = turf.buffer(u, -CATCHMENT_OFFSET, { units: 'kilometers' });
            outline = turf.featureCollection([shrunk && shrunk.geometry ? shrunk : u]);
        } catch (e) {
            // console.warn('[turf] catchment union failed:', e?.message);
            outline = fc; // fall back to undissolved boundaries
        }
    }

    let areaKm2 = 0;
    try { areaKm2 = turf.area(outline) / 1e6; } catch { /* ignore */ }

    const result = { outline, subdistricts: fc, areaKm2 };
    catchmentCache.set(key, result);
    return result;
}

// Resolve the subdistrict name for a hospital at [lng, lat].
// 1) polygon containment against the catchment boundaries (has subdistrict_name);
// 2) fallback: nearest POI point's master_id, matched to a boundary name.
export function subdistrictNameAt(boundariesFC, lng, lat, poiFC) {
    const pt = turf.point([lng, lat]);
    const feats = boundariesFC?.features || [];
    for (const f of feats) {
        if (!f?.geometry) continue;
        try { if (turf.booleanPointInPolygon(pt, f)) return f.properties?.subdistrict_name || null; }
        catch { /* ignore */ }
    }
    // Fallback: nearest POI (restricted to catchment subdistricts) → name.
    const pois = poiFC?.features || [];
    if (!pois.length || !feats.length) return null;
    const nameById = new Map(feats.map((f) => [f.properties?.master_id, f.properties?.subdistrict_name]));
    let bestId = null, min = Infinity;
    for (const p of pois) {
        const id = p?.properties?.master_id;
        const c = p?.geometry?.coordinates;
        if (!c || !nameById.has(id)) continue;
        const dx = c[0] - lng, dy = c[1] - lat, d = dx * dx + dy * dy;
        if (d < min) { min = d; bestId = id; }
    }
    return bestId == null ? null : (nameById.get(bestId) || null);
}

// Returns the hospital features that fall inside a catchment outline FeatureCollection.
export function hospitalsInCatchment(outline, hospitalFeatures) {
    const polys = (outline?.features || []).filter((f) => f?.geometry);
    if (!polys.length || !hospitalFeatures?.length) return [];
    return hospitalFeatures.filter((h) => {
        const c = h?.geometry?.coordinates;
        if (!c) return false;
        const pt = turf.point(c);
        return polys.some((poly) => {
            try { return turf.booleanPointInPolygon(pt, poly); }
            catch { return false; }
        });
    });
}
