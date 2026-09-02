import React, { useState, useEffect, useRef, useMemo } from 'react';
import { MapContainer, TileLayer, GeoJSON, Marker, Tooltip, useMapEvents, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { solveCarePathway, getCellCatchment, hospitalsInCatchment, subdistrictNameAt } from '../services/turfService';
import { fetchHospitals, fetchPoiSubdistricts, fetchSplitRoads, fetchStateBoundaries } from '../lib/fetchSpatial';
import { searchPlaces } from '../lib/geocode';
import { CareBandBarChart, CatchmentTypesPieChart, CompareStackedBar, CompareMetricBar, ComparePie } from './charts';

// ── Constants ────────────────────────────────────────────────────────────────

const CARE_BANDS = [
    { color: '#3700ff', light: '#c3b8ff', label: '0 – 50 km' },
    { color: '#00b93e', light: '#a8e8c1', label: '50 – 100 km' },
    { color: '#ffa600', light: '#ffe0a3', label: '100 – 200 km' },
    { color: '#7c0d0d', light: '#e3a9a9', label: '200+ km' },
];

// Primary UI accent colour, used for buttons, active states, markers, etc.
const UI_COLOR = '#06505c';
const UI_COLOR_LIGHT = '#5bb8c4'; // lighter tint (e.g. slider fill, hover states)

// Hospital marker colours.
const EXISTING_HOSP_COLOR = '#005194'; // existing/base hospitals
const USER_HOSP_COLOR = '#fffb00';     // user-added hospitals
const EXISTING_HOSP_STROKE = '#ffffff';  // existing hospital marker border colour
const USER_HOSP_STROKE = '#000000';      // user-added hospital marker border colour
const HOSP_STROKE_WIDTH = 2;             // marker border thickness (px) — shared by both

// Distinct outline colours for the compare-mode catchments (max 5).
const COMPARE_COLORS = ['#e8354a', '#1d6ef5', '#16a34a', '#f59e0b', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5'];
// Unique colour per catchment, unlimited: palette first, then golden-angle hues.
function compareColor(idx) {
    if (idx < COMPARE_COLORS.length) return COMPARE_COLORS[idx];
    return `hsl(${(idx * 137.508) % 360}, 65%, 45%)`;
}
const COMPARE_PIE_THRESHOLD = 10; // more than this many catchments → show a pie instead of bars

// ── Panel sizing (single source of truth — edit here) ──
const LEFT_WIDTH = 'calc(30vw - 16px)'; // horizontal width of the two left panels
const DASH_HEIGHT = '60vh';             // dashboard (top-left) panel height
const EDIT_HEIGHT = '10vh';             // edit (bottom-left) panel height
const RIGHT_WIDTH = 250;                // right controls panel width (px)

// Toggle visibility of the "View Voronoi" debug button.
const SHOW_VORONOI_BUTTON = false;


// Highlight style applied to a catchment subdistrict on hover (map or dashboard).
const SUBDISTRICT_HOVER_STYLE = { fillColor: '#ffffff', color: '#ffffff', fillOpacity: 0.65, weight: 2 };

const HOSPITAL_TYPES = ['Trust', 'Private', 'GOI'];
// Front-end-only display label for a hospital type (underlying value unchanged).
const typeLabel = (t) => (t === 'GOI' ? 'Government' : t);
const EMPANELMENT_OPTIONS = ['', 'PMJAY', 'Yes (Not Specified)'];

const DEFAULT_FUNCTION_SETTINGS = { clusterRadius: 3, searchRadius: 0.1 };

const BOOLEAN_FIELDS = [
    'Radiation Oncology', 'Medical Oncology', 'Surgical Oncology',
    'Medical Education', 'Medical Research', 'Mammography',
    'CT-Scan', 'MRI', 'PET-CT', 'Ultrasound', 'Brachytherapy',
    'Palliative Care', 'Bone Marrow Transplant',
];

const DEFAULT_PROPS = {
    name: '', 'Hospital Type': 'Trust', city: '', state: 'Maharashtra',
    'Regional Hospital': false, 'Year Established': '', Links: '', description: '',
    'Bed Count': '', 'ICU Bed Count': '', 'ot count': '', 'Doctor Count': '',
    'Staff Count': '', 'Built up area  ( sq ft )': '', Accreditation: '',
    'Empanelment Type': '', 'Sub-District ID': '', 'Radiation Bunker LINAC': '',
    ...Object.fromEntries(BOOLEAN_FIELDS.map(f => [f, false])),
    source: 'user_added',
};

const FUNCTION_KEYS = ['carepathway', 'fn2', 'weighted-voronoi', 'circles', 'fn5', 'fn6'];
const FUNCTION_NAMES = {
    'carepathway':      'Care Pathways',
    'fn2':              'Function 2',
    'weighted-voronoi': 'Weighted Voronoi',
    'circles':          'Overlapping Circles',
    'fn5':              'Function 5',
    'fn6':              'Function 6',
};

// India bounding box [minLng, minLat, maxLng, maxLat] → Leaflet bounds [[S,W],[N,E]].
const INDIA_BBOX = [68.135789, 8.102689, 97.371994, 37.056175];
const INDIA_BOUNDS = [
    [INDIA_BBOX[1], INDIA_BBOX[0]],
    [INDIA_BBOX[3], INDIA_BBOX[2]],
];

const BASEMAPS = {
    satellite: {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        attribution: '© Esri',
        label: 'SAT',
        name: 'Satellite',
    },
    osm: {
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        attribution: '© OpenStreetMap contributors',
        label: 'OSM',
        name: 'OpenStreetMap',
    },
    lightgray: {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
        attribution: '© Esri',
        label: 'GRY',
        name: 'Light Gray',
    },
    terrain: {
        url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
        attribution: '© OpenTopoMap contributors',
        label: 'TER',
        name: 'Terrain',
    },
};

const baseHospitalIcon = L.divIcon({
    className: '',
    html: `<div style="width:10px;height:10px;background:${EXISTING_HOSP_COLOR};border:${HOSP_STROKE_WIDTH}px solid ${EXISTING_HOSP_STROKE};border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,0.5)"></div>`,
    iconSize: [10, 10],
    iconAnchor: [5, 5],
});

// Smaller, muted marker for hospitals filtered out of the functions.
const baseHospitalIconSmall = L.divIcon({
    className: '',
    html: `<div style="width:7px;height:7px;background:${EXISTING_HOSP_COLOR};border:${HOSP_STROKE_WIDTH}px solid ${EXISTING_HOSP_STROKE};border-radius:50%;opacity:0.6"></div>`,
    iconSize: [10, 10],
    iconAnchor: [5, 5],
});

const userHospitalIcon = L.divIcon({
    className: '',
    html: `<div style="width:12px;height:12px;background:${USER_HOSP_COLOR};border:${HOSP_STROKE_WIDTH}px solid ${USER_HOSP_STROKE};border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,0.5)"></div>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
});

// Enlarged user-hospital marker — used on hover (edit/move) and while dragging.
const userHospitalIconLarge = L.divIcon({
    className: '',
    html: `<div style="width:18px;height:18px;background:${USER_HOSP_COLOR};border:${HOSP_STROKE_WIDTH}px solid ${USER_HOSP_STROKE};border-radius:50%;box-shadow:0 2px 5px rgba(0,0,0,0.5)"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
});

// Enlarged + red user-hospital marker — used on hover in delete mode.
const userHospitalIconRed = L.divIcon({
    className: '',
    html: '<div style="width:18px;height:18px;background:#e8354a;border:2px solid white;border-radius:50%;box-shadow:0 2px 5px rgba(0,0,0,0.5)"></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
});

// Pin marker (teardrop) used for a hospital whose catchment is active. Same fill /
// stroke styling as the circle markers, anchored at the bottom tip.
function makePinIcon(color, stroke, scale = 1) {
    const w = Math.round(34 * scale), h = Math.round(44 * scale);
    const html = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 24 34">`
        + `<path d="M12 1C6 1 1 6 1 12c0 8.5 11 21 11 21s11-12.5 11-21C23 6 18 1 12 1z" fill="${color}" stroke="${stroke}" stroke-width="${HOSP_STROKE_WIDTH}"/>`
        + `<circle cx="12" cy="12" r="4" fill="${stroke}"/></svg>`;
    // tooltipAnchor points to the top-center of the pin so "top" tooltips sit above
    // the whole pin instead of over it (the icon anchor is the tip at the location).
    return L.divIcon({ className: '', html, iconSize: [w, h], iconAnchor: [w / 2, h], tooltipAnchor: [0, -h] });
}
const baseHospitalPin = makePinIcon(EXISTING_HOSP_COLOR, EXISTING_HOSP_STROKE);
const userHospitalPin = makePinIcon(USER_HOSP_COLOR, USER_HOSP_STROKE);
const baseHospitalPinBig = makePinIcon(EXISTING_HOSP_COLOR, EXISTING_HOSP_STROKE, 1.6);
const userHospitalPinBig = makePinIcon(USER_HOSP_COLOR, USER_HOSP_STROKE, 1.6);

// Cursor for "add" mode: a user-hospital dot inside a green ring.
// The whole SVG is URL-encoded (incl. spaces) — Chrome rejects data-URI cursors
// that contain raw spaces or unencoded '#'.
const ADD_CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="13" fill="none" stroke="#16a34a" stroke-width="2.5"/><circle cx="16" cy="16" r="7" fill="${USER_HOSP_COLOR}" stroke="${USER_HOSP_STROKE}" stroke-width="2.5"/></svg>`;
const ADD_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(ADD_CURSOR_SVG)}") 16 16, crosshair`;

// ── Aggregation helpers (read the catchment object shape) ─────────────────────

// Sum subdistrict population per care band → [pop0, pop1, pop2, pop3].
function bandPopulation(catchment) {
    const sums = [0, 0, 0, 0];
    for (const f of catchment?.subdistricts?.features || []) {
        const bi = catchment.bands?.[f.properties?.master_id];
        if (bi == null) continue;
        sums[bi] += Number(f.properties?.pop_pc_total) || 0;
    }
    return sums;
}

// Count other hospitals in the catchment by ownership type → [{ type, count }].
function ownershipBreakdown(otherHosp) {
    const counts = {};
    for (const h of otherHosp || []) {
        const t = h.properties?.['Hospital Type'] || 'No Data';
        counts[t] = (counts[t] || 0) + 1;
    }
    return Object.entries(counts).map(([type, count]) => ({ type, count }));
}

// ── Sub-components ────────────────────────────────────────────────────────────

function MapClickHandler({ activeToolMode, onAddClick }) {
    useMapEvents({
        click: (e) => { if (activeToolMode === 'add') onAddClick(e.latlng); },
    });
    return null;
}

// Reports the current zoom level (and logs it via console.info, which bypasses
// the global console.log mute). Drives zoom-dependent line weights.
function ZoomLogger({ onZoom }) {
    const map = useMapEvents({
        zoomend: () => { const z = map.getZoom(); /* console.info('[zoom]', z); */ onZoom?.(z); },
    });
    useEffect(() => { const z = map.getZoom(); /* console.info('[zoom]', z); */ onZoom?.(z); }, [map]);
    return null;
}

// Creates a custom Leaflet pane for city labels, sitting above the care-pathway
// canvas (overlayPane 400) but below hospital markers (markerPane 600), so labels
// read over the lines while pins stay on top and clickable. Non-interactive.
function LabelsPane() {
    const map = useMap();
    useEffect(() => {
        if (!map.getPane('city-labels')) {
            map.createPane('city-labels');
            const p = map.getPane('city-labels');
            p.style.zIndex = 550;            // above overlay(400)/shadow(500), below markers(600)
            p.style.pointerEvents = 'none';  // never intercept map clicks
        }
    }, [map]);
    return null;
}

// City-label overlay: shown only at/above this zoom (below it the map is at
// country/state scale where per-city labels aren't useful and clutter).
const CITY_LABEL_MIN_ZOOM = 7;
const CITY_LABELS = {
    // CARTO labels-only raster (place names, transparent bg, built-in halos).
    light: 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png',
    dark:  'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors © CARTO',
};

// Care-pathway line-weight multiplier per zoom band (3 values: low / mid / high zoom).
const LINE_WEIGHT_MULT = [0.4, 0.8, 3];
// Zoom-band domain breakpoints — exactly TWO ascending numbers. They split zoom
// into: band 0 = z ≤ ZOOM_BREAKS[0], band 1 = ≤ ZOOM_BREAKS[1], band 2 = above.
const ZOOM_BREAKS = [7, 11];
const zoomBandIndex = (z) => (z <= ZOOM_BREAKS[0] ? 0 : z <= ZOOM_BREAKS[1] ? 1 : 2);

function HospitalDialog({ dialogState, onSubmit, onClose }) {
    const [form, setForm] = useState(dialogState.data);
    const set = (key, val) => setForm(f => ({ ...f, [key]: val }));

    const labelStyle = { display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 2, marginTop: 10 };
    const inputStyle = {
        width: '100%', padding: '4px 6px', boxSizing: 'border-box',
        fontSize: 13, border: '1px solid #ccc', borderRadius: 4, background: 'white', color: '#222',
    };

    return (
        <div style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
            zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
            <div style={{
                background: 'white', borderRadius: 10, width: 480, maxHeight: '85vh',
                display: 'flex', flexDirection: 'column', boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
            }}>
                <div style={{ padding: '14px 18px', borderBottom: '1px solid #eee', fontWeight: 'bold', fontSize: 15 }}>
                    {dialogState.mode === 'add' ? 'Add Hospital' : 'Edit Hospital'}
                </div>

                <div style={{ padding: '10px 18px', overflowY: 'auto', flex: 1 }}>
                    <label style={labelStyle}>Name</label>
                    <input style={inputStyle} value={form.name || ''} onChange={e => set('name', e.target.value)} />

                    <label style={labelStyle}>Hospital Type</label>
                    <select style={inputStyle} value={form['Hospital Type']} onChange={e => set('Hospital Type', e.target.value)}>
                        {HOSPITAL_TYPES.map(t => <option key={t} value={t}>{typeLabel(t)}</option>)}
                    </select>
                </div>

                <div style={{ padding: '12px 18px', borderTop: '1px solid #eee', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <button onClick={onClose} style={{ padding: '6px 14px', border: '1px solid #f3b5b5', borderRadius: 5, cursor: 'pointer', background: '#fdeaea', color: '#c0392b' }}>
                        Cancel
                    </button>
                    <button onClick={() => onSubmit(form)} style={{ padding: '6px 14px', border: 'none', borderRadius: 5, cursor: 'pointer', background: UI_COLOR, color: 'white', fontWeight: 600 }}>
                        {dialogState.mode === 'add' ? 'Add' : 'Save'}
                    </button>
                </div>
            </div>
        </div>
    );
}

function FunctionSettingsDialog({ activeFunction, settings, onSave, onClose }) {
    const [local, setLocal] = useState({ ...settings });
    const set = (key, val) => setLocal(s => ({ ...s, [key]: val }));

    const labelStyle = { display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 2, marginTop: 10 };
    const inputStyle = {
        width: '100%', padding: '4px 6px', boxSizing: 'border-box',
        fontSize: 13, border: '1px solid #ccc', borderRadius: 4, background: 'white', color: '#222',
    };

    return (
        <div style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
            zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
            <div style={{
                background: 'white', borderRadius: 10, width: 340,
                display: 'flex', flexDirection: 'column', boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
            }}>
                <div style={{ padding: '14px 18px', borderBottom: '1px solid #eee', fontWeight: 'bold', fontSize: 15 }}>
                    {FUNCTION_NAMES[activeFunction]} — Settings
                </div>
                <div style={{ padding: '10px 18px 18px' }}>
                    {activeFunction === 'carepathway' ? (
                        <>
                            <label style={labelStyle}>Cluster Radius (km)</label>
                            <input style={inputStyle} type="number" step="0.05" min="0.1"
                                value={local.clusterRadius}
                                onChange={e => set('clusterRadius', Number(e.target.value))} />
                            <label style={labelStyle}>Search Radius (degrees)</label>
                            <input style={inputStyle} type="number" step="0.01" min="0.01"
                                value={local.searchRadius}
                                onChange={e => set('searchRadius', Number(e.target.value))} />
                        </>
                    ) : (
                        <div style={{ padding: '16px 0', color: '#888', fontSize: 13, textAlign: 'center' }}>
                            Settings coming soon
                        </div>
                    )}
                </div>
                <div style={{ padding: '12px 18px', borderTop: '1px solid #eee', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <button onClick={onClose} style={{ padding: '6px 14px', border: '1px solid #ccc', borderRadius: 5, cursor: 'pointer', background: 'white' }}>
                        Cancel
                    </button>
                    <button onClick={() => onSave(local)} style={{ padding: '6px 14px', border: 'none', borderRadius: 5, cursor: 'pointer', background: UI_COLOR, color: 'white', fontWeight: 600 }}>
                        Save
                    </button>
                </div>
            </div>
        </div>
    );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MapComponent({ computeEnabled = true, onOpenSplash }) {
    const [roads, setRoads] = useState(null);
    const [subdistricts, setSubdistricts] = useState(null);
    const [hospitals, setHospitals] = useState(null);
    const [userAddedHospitals, setUserAddedHospitals] = useState([]);
    const [computedOutputs, setComputedOutputs] = useState({ carepathway: null });
    const [isComputing, setIsComputing] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [computeId, setComputeId] = useState(0);
    const [activeToolMode, setActiveToolMode] = useState(null);
    const [dialogState, setDialogState] = useState(null);
    const hospitalCounterRef = useRef(0); // auto-numbering for added hospital names
    const [basemap, setBasemap] = useState('osm');
    const [tileOpacity, setTileOpacity] = useState(0.5); // basemap transparency (0.5 = 50% transparent)
    const [mapZoom, setMapZoom] = useState(5);
    const [toast, setToast] = useState(null); // transient message (e.g. filtered-out hospital click)
    const [visibleTypes, setVisibleTypes] = useState(new Set(HOSPITAL_TYPES));
    const [hospitalTypes, setHospitalTypes] = useState(HOSPITAL_TYPES);
    const [activeFunction, setActiveFunction] = useState('carepathway');
    const [functionSettings, setFunctionSettings] = useState(DEFAULT_FUNCTION_SETTINGS);
    const [functionSettingsOpen, setFunctionSettingsOpen] = useState(false);
    const [showVoronoi, setShowVoronoi] = useState(false);
    // Administrative boundaries — off by default; state boundaries lazy-loaded on first enable.
    const [showStateBoundary, setShowStateBoundary] = useState(false);
    const [stateBoundaries, setStateBoundaries] = useState(null);
    const [stateBoundaryLoading, setStateBoundaryLoading] = useState(false);
    const [catchment, setCatchment] = useState(null);
    const [catchmentLoading, setCatchmentLoading] = useState(false);
    const [filteredOutNotice, setFilteredOutNotice] = useState(false);

    // ── New UI shell state ──
    const mapRef = useRef(null); // Leaflet map instance (for search-triggered zoom)
    const catchmentKeysRef = useRef(new Set()); // coord keys of active-catchment hospitals (for marker pins)
    const [placeQuery, setPlaceQuery] = useState(''); // navbar place-search query
    const [placeResults, setPlaceResults] = useState([]); // geocoder autocomplete results
    const [dashCollapsed, setDashCollapsed] = useState(true);
    const dashAutoOpenedRef = useRef(false); // auto-open the dashboard on the first catchment
    const [editCollapsed, setEditCollapsed] = useState(true);
    const [rightCollapsed, setRightCollapsed] = useState(false);
    const [dashboardTab, setDashboardTab] = useState('stats'); // 'stats' | 'compare'
    const [compareCatchments, setCompareCatchments] = useState([]); // ordered, max 5
    const [compareMetric, setCompareMetric] = useState('population'); // 'population' | 'consumption'
    const [hoverCompareId, setHoverCompareId] = useState(null); // compare row hovered → highlight its pin + outline

    // Leaflet layer lookups so the dashboard list can drive map hover.
    const subLayerRef = useRef(new Map());   // master_id -> subdistrict layer
    const hospLayerRef = useRef(new Map());  // "lng,lat" coord key -> marker layer (names can collide)

    const roadsRef = useRef(null);
    const subdistRef = useRef(null);
    const hospitalsRef = useRef(null);
    const userAddedHospitalsRef = useRef([]);
    const visibleTypesRef = useRef(new Set(HOSPITAL_TYPES));
    const functionSettingsRef = useRef(DEFAULT_FUNCTION_SETTINGS);
    const showVoronoiRef = useRef(true);
    const cellsRef = useRef([]);
    const activeCatchmentKeyRef = useRef(null);
    const activeHospitalRef = useRef(null);  // identity of the selected hospital, for re-resolving on recompute
    const activeToolModeRef = useRef(null);
    const importInputRef = useRef(null);
    const pendingInitialComputeRef = useRef(null);
    const filterDebounceRef = useRef(null);
    const searchDebounceRef = useRef(null); // debounce for place-search keystrokes
    const searchAbortRef = useRef(null);    // aborts stale geocoder requests
    const computeEnabledRef = useRef(computeEnabled);
    const dashboardTabRef = useRef('stats');
    const compareCatchmentsRef = useRef([]);
    const dragIndexRef = useRef(null); // compare-list drag source index
    const carepathwayRef = useRef(null); // care-pathway GeoJSON layer, for live restyle on zoom/weight change
    const toastTimerRef = useRef(null);

    // Briefly show a transient message.
    const showToast = (msg) => {
        setToast(msg);
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        toastTimerRef.current = setTimeout(() => setToast(null), 2200);
    };
    const hospitalDraggingRef = useRef(false); // a user hospital is mid-drag (avoids icon swap during drag)

    useEffect(() => { dashboardTabRef.current = dashboardTab; }, [dashboardTab]);

    // Care-pathway line style: care-band colour, weight scaled by the active
    // zoom band's multiplier.
    const carepathwayStyle = (f) => ({
        color: f?.properties?.careColor || 'purple',
        weight: (f?.properties?.careLineWeight || 3) * LINE_WEIGHT_MULT[zoomBandIndex(mapZoom)],
    });

    // Re-apply weights live when the zoom band changes (no remount, so it
    // stays fast on large feature sets).
    useEffect(() => {
        carepathwayRef.current?.setStyle(carepathwayStyle);
    }, [mapZoom]);

    // Run the deferred initial compute once compute is enabled (splash closed).
    // Uses a ref so the data-load effect (which captures computeEnabled at mount)
    // reads the live value rather than the stale initial one.
    useEffect(() => {
        computeEnabledRef.current = computeEnabled;
        if (!computeEnabled) return;
        const pending = pendingInitialComputeRef.current;
        if (!pending) return;
        pendingInitialComputeRef.current = null;
        triggerCompute(pending.h, [], pending.r, pending.s, pending.initialVisible);
    }, [computeEnabled]);

    // ── Load data ──────────────────────────────────────────────────────────────

    useEffect(() => {
        const load = async () => {
            try {
                const [h, s, r] = await Promise.all([
                    fetchHospitals(),
                    fetchPoiSubdistricts(),
                    fetchSplitRoads(),
                ]);

                // Drop hospitals with no ownership type ("null" rows from Supabase).
                h.features = h.features.filter(f => f.properties?.['Hospital Type']);

                // console.log('[map] fetched — hospitals:', h.features?.length, 'poi subdistricts:', s.features?.length, 'roads:', r.features?.length);

                const types = [...new Set(h.features.map(f => f.properties?.['Hospital Type']).filter(Boolean))];
                const OFF_BY_DEFAULT = new Set(['Private']);
                const initialVisible = new Set(types.filter(t => !OFF_BY_DEFAULT.has(t)));
                setHospitalTypes(types);
                setVisibleTypes(initialVisible);
                visibleTypesRef.current = initialVisible;

                roadsRef.current = r;
                subdistRef.current = s;
                hospitalsRef.current = h;

                setHospitals(h);
                setRoads(r);
                setSubdistricts(s);

                // Defer the initial compute until the splash screen is closed.
                if (computeEnabledRef.current) {
                    triggerCompute(h, [], r, s, initialVisible);
                } else {
                    pendingInitialComputeRef.current = { h, r, s, initialVisible };
                }
                setIsLoading(false);
            } catch (err) {
                // console.error('Initialization failed:', err);
                setIsLoading(false);
            }
        };
        load();
    }, []);

    // ── Compute ────────────────────────────────────────────────────────────────

    useEffect(() => { activeToolModeRef.current = activeToolMode; }, [activeToolMode]);

    const triggerCompute = async (baseH, userH, r, s, overrideVisibleTypes, overrideSettings) => {
        if (!baseH || !r || !s) return;
        setIsComputing(true);
        try {
            const vt = overrideVisibleTypes ?? visibleTypesRef.current;
            const settings = overrideSettings ?? functionSettingsRef.current;
            const passesFilter = (f) => {
                const t = f.properties?.['Hospital Type'];
                return t ? vt.has(t) : false;
            };
            const filteredBase = baseH.features.filter(passesFilter);
            // User-added hospitals must also respect the active filter.
            const filteredUser = userH.filter(passesFilter);
            const combined = { ...baseH, features: [...filteredBase, ...filteredUser] };
            const filterSig = [...vt].sort().join(',');
            const results = await solveCarePathway(JSON.stringify(combined), JSON.stringify(r), JSON.stringify(s), settings, filterSig);
            // console.log('[map] compute result — carepathway features:', results?.carepathway?.features?.length);
            if (results) { setComputedOutputs(results); setComputeId(n => n + 1); cellsRef.current = results.cells || []; }

            // Refresh the selected hospital's catchment against the new cells.
            // The old catchment/dashboard stay visible until this completes.
            const active = activeHospitalRef.current;
            if (active) {
                const passes = active.isUser || (active.type ? vt.has(active.type) : false);
                if (!passes) {
                    // Hospital no longer participates — prompt, keep old catchment until OK.
                    setFilteredOutNotice(true);
                } else {
                    await applyCatchment(active.lng, active.lat, active.name, active.subdistrict);
                }
            }

            // Refresh any compare-mode catchments against the new cells. Each entry
            // is rebuilt from its source hospital; only entries whose result actually
            // changed (different cell key or band layout) are replaced.
            const compare = compareCatchmentsRef.current;
            if (compare.length) {
                const sig = (c) => `${c.key}|${JSON.stringify(c.bands)}`;
                let changed = false;
                const refreshed = await Promise.all(compare.map(async (entry) => {
                    const passes = entry.isUser || (entry.type ? vt.has(entry.type) : false);
                    if (!passes) return entry; // filtered-out handling lives in toggleType
                    const rebuilt = await buildCatchment(entry.lng, entry.lat, entry.name, entry.subdistrict);
                    if (!rebuilt) return entry;
                    if (sig(rebuilt.catchment) === sig(entry.catchment) && rebuilt.key === entry.key) {
                        return entry; // unchanged
                    }
                    changed = true;
                    return { ...entry, id: rebuilt.key, key: rebuilt.key, catchment: rebuilt.catchment };
                }));
                if (changed) {
                    compareCatchmentsRef.current = refreshed;
                    setCompareCatchments(refreshed);
                }
            }
        } catch (err) {
            // console.error('Compute failed:', err);
        } finally {
            setIsComputing(false);
        }
    };

    // ── Tool mode ──────────────────────────────────────────────────────────────

    const setTool = (mode) => setActiveToolMode(prev => prev === mode ? null : mode);

    // ── Add hospital ───────────────────────────────────────────────────────────

    const handleAddClick = (latlng) => {
        // Minimal form — hospital name (pre-filled with the next auto number) + type.
        const suggested = `Hospital${hospitalCounterRef.current + 1}`;
        setDialogState({ mode: 'add', latlng, data: { name: suggested, 'Hospital Type': 'Trust' } });
    };

    const handleDialogSubmit = (formData) => {
        // User-added hospitals carry only name + Hospital Type.
        const properties = { name: formData.name || '', 'Hospital Type': formData['Hospital Type'] };
        const feature = {
            type: 'Feature',
            properties,
            geometry: {
                type: 'Point',
                coordinates: [dialogState.latlng?.lng ?? 0, dialogState.latlng?.lat ?? 0],
            },
        };

        let updated;
        if (dialogState.mode === 'add') {
            updated = [...userAddedHospitals, feature];
            hospitalCounterRef.current += 1;
        } else {
            updated = [...userAddedHospitals];
            const prev = updated[dialogState.idx];
            updated[dialogState.idx] = { ...prev, properties };

            // Reflect the edited name/type in any open stats / compare catchments
            // that were built from this hospital (edit keeps the same coordinates).
            const [lng, lat] = prev.geometry?.coordinates || [];
            const sameHosp = (c) => c && c.isUser && c.lng === lng && c.lat === lat;
            const newName = properties.name || 'Hospital';
            const newType = properties['Hospital Type'];

            if (sameHosp(activeHospitalRef.current)) {
                activeHospitalRef.current = { ...activeHospitalRef.current, name: newName, type: newType };
            }
            if (compareCatchmentsRef.current.some(sameHosp)) {
                const nextCompare = compareCatchmentsRef.current.map(c =>
                    sameHosp(c) ? { ...c, name: newName, type: newType } : c);
                compareCatchmentsRef.current = nextCompare;
                setCompareCatchments(nextCompare);
            }
        }

        userAddedHospitalsRef.current = updated;
        setUserAddedHospitals(updated);
        setDialogState(null);
        // After adding a hospital, collapse the Interact panel and exit the tool mode.
        if (dialogState.mode === 'add') {
            setEditCollapsed(true);
            setActiveToolMode(null);
        }
        triggerCompute(hospitalsRef.current, updated, roadsRef.current, subdistRef.current);
    };

    // ── Move hospital ──────────────────────────────────────────────────────────

    const handleDragEnd = (idx, latlng) => {
        const prev = userAddedHospitals[idx];
        const updated = [...userAddedHospitals];
        updated[idx] = { ...prev, geometry: { type: 'Point', coordinates: [latlng.lng, latlng.lat] } };
        userAddedHospitalsRef.current = updated;
        setUserAddedHospitals(updated);

        // If the moved hospital owns the active catchment, follow it to its new
        // location so triggerCompute re-resolves its OWN cell (not whatever cluster
        // happened to be nearest the old position).
        const active = activeHospitalRef.current;
        if (active && active.isUser) {
            const [oldLng, oldLat] = prev.geometry.coordinates;
            if (active.lng === oldLng && active.lat === oldLat) {
                activeHospitalRef.current = { ...active, lng: latlng.lng, lat: latlng.lat };
            }
        }

        triggerCompute(hospitalsRef.current, updated, roadsRef.current, subdistRef.current);
    };

    // ── Delete hospital ────────────────────────────────────────────────────────

    const handleDeleteHospital = (idx) => {
        const removed = userAddedHospitals[idx];
        const updated = userAddedHospitals.filter((_, i) => i !== idx);
        userAddedHospitalsRef.current = updated;
        setUserAddedHospitals(updated);

        // If the deleted hospital owned the active catchment, clear it so
        // triggerCompute doesn't re-resolve a new catchment in its place.
        const active = activeHospitalRef.current;
        if (active && active.isUser) {
            const [oldLng, oldLat] = removed.geometry.coordinates;
            if (active.lng === oldLng && active.lat === oldLat) {
                activeHospitalRef.current = null;
                activeCatchmentKeyRef.current = null;
                setCatchment(null);
            }
        }

        triggerCompute(hospitalsRef.current, updated, roadsRef.current, subdistRef.current);
    };

    // ── Import / Export ────────────────────────────────────────────────────────

    const handleImport = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const parsed = JSON.parse(ev.target.result);
                if (parsed.type !== 'FeatureCollection') throw new Error('Not a FeatureCollection');
                const points = parsed.features
                    .filter(f => f.geometry?.type === 'Point')
                    .map(f => ({
                        type: 'Feature',
                        geometry: f.geometry,
                        properties: { name: f.properties?.name ?? '', 'Hospital Type': f.properties?.['Hospital Type'] ?? 'Trust' },
                    }));
                userAddedHospitalsRef.current = points;
                setUserAddedHospitals(points);
                triggerCompute(hospitalsRef.current, points, roadsRef.current, subdistRef.current);
            } catch (err) {
                // console.error('Import failed:', err);
                alert('Invalid GeoJSON file. Must be a FeatureCollection of Points.');
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    };

    const handleExport = () => {
        const features = userAddedHospitals.map(f => ({
            type: 'Feature',
            geometry: f.geometry,
            properties: { name: f.properties?.name ?? '', 'Hospital Type': f.properties?.['Hospital Type'] ?? 'Trust' },
        }));
        const fc = { type: 'FeatureCollection', features };
        const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'udhp-user-hospitals.geojson';
        a.click();
        URL.revokeObjectURL(url);
    };

    // ── Filter ─────────────────────────────────────────────────────────────────

    const toggleType = (type) => {
        const next = new Set(visibleTypesRef.current);
        next.has(type) ? next.delete(type) : next.add(type);
        visibleTypesRef.current = next;
        setVisibleTypes(new Set(next));
        // In compare mode, a filter change invalidates the saved catchments (the
        // underlying partition will be recomputed), so clear them and recalculate.
        if (dashboardTabRef.current === 'compare' && compareCatchmentsRef.current.length) {
            const filteredOut = compareCatchmentsRef.current.some(c => !next.has(c.type));
            compareCatchmentsRef.current = [];
            setCompareCatchments([]);
            showToast(filteredOut
                ? 'A compared hospital was filtered out — comparison cleared'
                : 'Filter changed — comparison cleared');
        }
        // Debounce recompute so a user editing several filters in a row only
        // triggers one compute 2.5s after their last change.
        if (filterDebounceRef.current) clearTimeout(filterDebounceRef.current);
        filterDebounceRef.current = setTimeout(() => {
            filterDebounceRef.current = null;
            if (hospitalsRef.current && roadsRef.current && subdistRef.current) {
                triggerCompute(hospitalsRef.current, userAddedHospitalsRef.current, roadsRef.current, subdistRef.current, visibleTypesRef.current);
            }
        }, 2500);
    };

    // ── Catchment on hospital click ──────────────────────────────────────────────

    // Nearest cell centroid to a clicked hospital.
    const findCell = (lng, lat) => {
        const cells = cellsRef.current;
        if (!cells.length) return null;
        let best = null, min = Infinity;
        for (const c of cells) {
            const dx = c.centroid[0] - lng, dy = c.centroid[1] - lat, d = dx * dx + dy * dy;
            if (d < min) { min = d; best = c; }
        }
        return best;
    };

    // Build (but don't set) the catchment object for a hospital at [lng, lat].
    const buildCatchment = async (lng, lat, name, subdistrict) => {
        const best = findCell(lng, lat);
        if (!best || !best.masterIds.length) return null;
        const result = await getCellCatchment(best.masterIds);
        const key = [...best.masterIds].sort().join(',');
        const allHosp = [
            ...(hospitalsRef.current?.features || []),
            ...userAddedHospitalsRef.current,
        ];
        const allInside = hospitalsInCatchment(result.outline, allHosp);
        // The active hospital is the one nearest the click point; remove it by
        // reference (handles duplicate names) but keep its type for the pie chart.
        let activeFeat = null, bestD = Infinity;
        for (const h of allInside) {
            const c = h.geometry?.coordinates;
            if (!c) continue;
            const d = (c[0] - lng) ** 2 + (c[1] - lat) ** 2;
            if (d < bestD) { bestD = d; activeFeat = h; }
        }
        const inside = allInside.filter((h) => h !== activeFeat);
        const hospitalType = activeFeat?.properties?.['Hospital Type'] ?? null;
        const sub = subdistrictNameAt(result.subdistricts, lng, lat, subdistRef.current) || subdistrict;
        const filterTypes = [...visibleTypesRef.current].join(', ') || 'No filters';
        return {
            key,
            catchment: { ...result, bands: best.bands, hospitalName: name, hospitalType, hospitalSubdistrict: sub, hospitals: inside, filterTypes },
        };
    };

    // Build & show the single (stats-mode) catchment. The previous catchment stays
    // on screen until the new one is ready.
    const applyCatchment = async (lng, lat, name, subdistrict) => {
        setCatchmentLoading(true);
        try {
            const built = await buildCatchment(lng, lat, name, subdistrict);
            if (!built) return false;
            activeCatchmentKeyRef.current = built.key;
            setCatchment(built.catchment);
            // The first time a catchment is calculated, reveal the dashboard panel.
            if (!dashAutoOpenedRef.current) {
                dashAutoOpenedRef.current = true;
                setDashCollapsed(false);
            }
            return true;
        } catch (err) {
            // console.error('Catchment failed:', err);
            return false;
        } finally {
            setCatchmentLoading(false);
        }
    };

    const handleHospitalClick = async (lng, lat, name, subdistrict, type, isUser) => {
        const best = findCell(lng, lat);
        if (!best || !best.masterIds.length) return;
        const key = [...best.masterIds].sort().join(',');

        // ── Compare mode: accumulate catchments (no limit), toggle off repeats.
        if (dashboardTabRef.current === 'compare') {
            const existing = compareCatchmentsRef.current.find(c => c.key === key);
            if (existing) {
                const next = compareCatchmentsRef.current.filter(c => c.key !== key);
                compareCatchmentsRef.current = next;
                setCompareCatchments(next);
                return;
            }
            setCatchmentLoading(true);
            try {
                const built = await buildCatchment(lng, lat, name, subdistrict);
                if (!built) return;
                const used = new Set(compareCatchmentsRef.current.map(c => c.colorIdx));
                let colorIdx = 0;
                while (used.has(colorIdx)) colorIdx++; // smallest free index → unique colour (no limit)
                const next = [...compareCatchmentsRef.current, {
                    id: built.key, key: built.key,
                    colorIdx, color: compareColor(colorIdx),
                    name: name || 'Hospital', type, lng, lat, subdistrict, isUser,
                    catchment: built.catchment,
                }];
                compareCatchmentsRef.current = next;
                setCompareCatchments(next);
            } catch (err) {
                // console.error('Catchment failed:', err);
            } finally {
                setCatchmentLoading(false);
            }
            return;
        }

        // ── Stats mode: single catchment. Toggle off only when the SAME active
        // hospital is clicked again — clicking a different hospital that shares the
        // cell (same metro/DBSCAN catchment) switches the active hospital instead.
        const a = activeHospitalRef.current;
        if (a && a.lng === lng && a.lat === lat) {            // same hospital → toggle off
            activeCatchmentKeyRef.current = null;
            activeHospitalRef.current = null;
            setCatchment(null);
            return;
        }
        activeHospitalRef.current = { lng, lat, name, subdistrict, type, isUser };
        await applyCatchment(lng, lat, name, subdistrict);
    };

    // ── Compare list reorder & removal ───────────────────────────────────────────

    const removeCompare = (key) => {
        const next = compareCatchmentsRef.current.filter(c => c.key !== key);
        compareCatchmentsRef.current = next;
        setCompareCatchments(next);
    };

    const reorderCompare = (from, to) => {
        if (from == null || to == null || from === to) return;
        const arr = [...compareCatchmentsRef.current];
        const [moved] = arr.splice(from, 1);
        arr.splice(to, 0, moved);
        compareCatchmentsRef.current = arr;
        setCompareCatchments(arr);
    };

    // Switch dashboard tab, carrying one catchment across the boundary:
    //  • → compare: seed the list with the active stats catchment as the first entry.
    //  • → stats:   keep only the first compare entry and show it as the stats catchment.
    const switchTab = (tab) => {
        if (tab === 'compare') {
            const key = activeCatchmentKeyRef.current;
            const a = activeHospitalRef.current;
            if (catchment && key && a && !compareCatchmentsRef.current.some(c => c.key === key)) {
                const entry = {
                    id: key, key, colorIdx: 0, color: COMPARE_COLORS[0],
                    name: a.name || 'Hospital', type: a.type, lng: a.lng, lat: a.lat,
                    subdistrict: a.subdistrict, isUser: a.isUser, catchment,
                };
                const next = [entry, ...compareCatchmentsRef.current];
                compareCatchmentsRef.current = next;
                setCompareCatchments(next);
            }
        } else {
            const list = compareCatchmentsRef.current;
            if (list.length) {
                const first = list[0];
                compareCatchmentsRef.current = [first];
                setCompareCatchments([first]);
                activeCatchmentKeyRef.current = first.key;
                activeHospitalRef.current = {
                    lng: first.lng, lat: first.lat, name: first.name,
                    subdistrict: first.subdistrict, type: first.type, isUser: first.isUser,
                };
                setCatchment(first.catchment);
            }
        }
        setDashboardTab(tab);
    };

    // ── Subdistrict styling / hover ──────────────────────────────────────────────

    const subdistrictStyle = (f) => {
        const bi = catchment?.bands?.[f.properties?.master_id];
        const band = CARE_BANDS[bi];
        return {
            color: band?.color || '#888',
            weight: 1,
            fillColor: band?.light || '#dddddd',
            fillOpacity: 0.55,
        };
    };

    // Dashboard list → map hover linking.
    const hoverSubdistrict = (masterId, on) => {
        const entry = subLayerRef.current.get(masterId);
        if (!entry) return;
        const { layer, feature } = entry;
        if (on) { layer.setStyle(SUBDISTRICT_HOVER_STYLE); layer.openTooltip?.(); }
        else { layer.setStyle(subdistrictStyle(feature)); layer.closeTooltip?.(); }
    };
    const hoverHospital = (lng, lat, on) => {
        const layer = hospLayerRef.current.get(coordKey(lng, lat));
        if (!layer) return;
        if (on) layer.openTooltip?.(); else layer.closeTooltip?.();
    };

    // ── Voronoi debug overlay ───────────────────────────────────────────────────

    const toggleVoronoi = () => {
        const next = !showVoronoiRef.current;
        showVoronoiRef.current = next;
        setShowVoronoi(next);
    };

    // Toggle the state-boundary overlay, lazy-fetching the geometry the first time on.
    const toggleStateBoundary = async () => {
        const next = !showStateBoundary;
        setShowStateBoundary(next);
        if (next && !stateBoundaries) {
            setStateBoundaryLoading(true);
            try {
                const fc = await fetchStateBoundaries();
                if (!fc.features?.length) {
                    showToast('No state boundaries found (check the table/RLS in Supabase)');
                }
                setStateBoundaries(fc);
            } catch (err) {
                showToast(`State boundaries failed to load: ${err?.message || err}`);
            } finally {
                setStateBoundaryLoading(false);
            }
        }
    };

    // ── Function switcher (machinery kept; buttons no longer rendered) ───────────

    const handleFunctionClick = (key) => {
        if (key === activeFunction) return;
        setActiveFunction(key);
        setCatchment(null);
        activeCatchmentKeyRef.current = null;
        const ready = hospitalsRef.current && roadsRef.current && subdistRef.current;
        if (key === 'carepathway' && ready) {
            triggerCompute(hospitalsRef.current, userAddedHospitalsRef.current, roadsRef.current, subdistRef.current);
        } else {
            setComputedOutputs({ carepathway: null });
        }
    };

    const handleFunctionSettingsSave = (newSettings) => {
        functionSettingsRef.current = newSettings;
        setFunctionSettings(newSettings);
        setFunctionSettingsOpen(false);
        const ready = hospitalsRef.current && roadsRef.current && subdistRef.current;
        if (activeFunction === 'carepathway' && ready) {
            triggerCompute(hospitalsRef.current, userAddedHospitalsRef.current, roadsRef.current, subdistRef.current, undefined, newSettings);
        }
    };

    // ── Display filter ─────────────────────────────────────────────────────────

    const isHospitalActive = (f) => {
        const t = f.properties?.['Hospital Type'];
        return t ? visibleTypes.has(t) : false;
    };

    const displayedHospitals = hospitals;

    // ── Shared styles ────────────────────────────────────────────────────────────

    const panelStyle = {
        background: 'white', borderRadius: 8,
        boxShadow: '0 2px 8px rgba(0,0,0,0.25)', padding: '10px 14px',
    };

    const toolBtnStyle = (active) => ({
        padding: '6px 12px', border: '1px solid #ccc', borderRadius: 6,
        cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap',
        background: active ? UI_COLOR : 'white',
        color: active ? 'white' : '#333',
        fontWeight: active ? 600 : 400,
    });

    // master_id → average of urban & rural per-capita consumption (from poi subdistricts).
    const consumptionByMaster = useMemo(() => {
        // null/'' must NOT become 0 — Number(null) === 0, which would pollute the median.
        const toNum = (v) => (v == null || v === '' ? NaN : Number(v));
        const map = new Map();
        for (const f of subdistricts?.features || []) {
            const mid = f.properties?.master_id;
            if (mid == null) continue;
            const vals = [toNum(f.properties?.cons_pc_urban), toNum(f.properties?.cons_pc_rural)]
                .filter((v) => Number.isFinite(v));
            if (vals.length === 0) continue;
            map.set(mid, vals.reduce((a, b) => a + b, 0) / vals.length);
        }
        return map;
    }, [subdistricts]);

    // Median per-subdistrict consumption (avg of urban+rural) across a catchment.
    // null when no subdistrict has data.
    const catchmentMedianConsumption = (cat) => {
        const vals = (cat?.subdistricts?.features || [])
            .map((f) => consumptionByMaster.get(f.properties?.master_id))
            .filter((v) => Number.isFinite(v))
            .sort((a, b) => a - b);
        if (!vals.length) return null;
        const mid = Math.floor(vals.length / 2);
        return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
    };

    // ── Stats-tab dashboard body ─────────────────────────────────────────────────

    const renderStatsTab = () => {
        if (!catchment) {
            return (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999', fontSize: 13, textAlign: 'center', padding: 20 }}>
                    Click a hospital marker to see its catchment.
                </div>
            );
        }
        const subs = [...(catchment.subdistricts?.features || [])]
            .map(f => ({
                masterId: f.properties?.master_id,
                name: f.properties?.subdistrict_name || 'Unknown',
                pop: Number(f.properties?.pop_pc_total) || 0,
            }))
            .sort((a, b) => b.pop - a.pop);
        const totalPop = subs.reduce((sum, s) => sum + s.pop, 0);
        const totalArea = catchment.areaKm2 || 0;
        // Median per-subdistrict consumption (avg of urban+rural) across the catchment.
        const consVals = subs
            .map((s) => consumptionByMaster.get(s.masterId))
            .filter((v) => Number.isFinite(v))
            .sort((a, b) => a - b);
        // Only show no-data when every subdistrict lacks consumption data.
        const consHasData = consVals.length > 0;
        let medianCons = null;
        if (consHasData) {
            const mid = Math.floor(consVals.length / 2);
            medianCons = consVals.length % 2 ? consVals[mid] : (consVals[mid - 1] + consVals[mid]) / 2;
        }
        const medianConsDisplay = consHasData
            ? `₹${Math.round(medianCons).toLocaleString('en-IN')}`
            : 'no-data';
        const otherHosp = [...(catchment.hospitals || [])].sort((a, b) => {
            const aa = isHospitalActive(a) ? 0 : 1;
            const bb = isHospitalActive(b) ? 0 : 1;
            return aa - bb;
        });
        const bandSums = bandPopulation(catchment);
        const barData = CARE_BANDS.map((b, i) => ({ band: b.label, pop: bandSums[i], color: b.color }));
        // Include the active (clicked) hospital itself in the ownership pie.
        const activeHospFeat = catchment.hospitalType ? [{ properties: { 'Hospital Type': catchment.hospitalType } }] : [];
        const pieData = ownershipBreakdown([...otherHosp, ...activeHospFeat]);

        const statRow = { fontSize: 12, color: '#333', marginTop: 4, display: 'flex', justifyContent: 'space-between', gap: 8 };
        const statLabel = { color: '#000', fontWeight: 700, cursor: 'default', userSelect: 'none', WebkitUserSelect: 'none' };
        const infoTip = (msg) => (
            <span title={msg} style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 13, height: 13, marginLeft: 4, borderRadius: '50%',
                background: '#fff', color: UI_COLOR_LIGHT, border: `1px solid ${UI_COLOR_LIGHT}`,
                fontSize: 9, fontWeight: 700, verticalAlign: 'middle',
            }}>?</span>
        );
        const matchedHosp = otherHosp.filter(isHospitalActive);
        const filteredHosp = otherHosp.filter((h) => !isHospitalActive(h));
        const subHead = { fontSize: 10, fontWeight: 700, color: '#777', textTransform: 'uppercase', letterSpacing: 0.5, margin: '4px 0 2px', textAlign: 'left' };
        const hospRow = (h, i) => (
            <div key={i}
                style={{ fontSize: 12, padding: '2px 0', cursor: 'pointer', color: isHospitalActive(h) ? '#222' : '#aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                onMouseEnter={() => hoverHospital(h.geometry?.coordinates?.[0], h.geometry?.coordinates?.[1], true)}
                onMouseLeave={() => hoverHospital(h.geometry?.coordinates?.[0], h.geometry?.coordinates?.[1], false)}>
                {h.properties?.name || 'Unknown'}
            </div>
        );

        return (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                {/* Hospital header — centered name + subdistrict */}
                <div style={{ textAlign: 'center', padding: '10px 12px 8px', borderBottom: '1px solid #eee' }}>
                    <div className="panel-title" style={{ marginBottom: 0, textAlign: 'center' }}>{catchment.hospitalName || 'Hospital'}</div>
                    <div style={{ fontSize: 11, color: '#777' }}>{catchment.hospitalSubdistrict || '—'}</div>
                </div>
                {/* TOP GRID — left (stats + hospitals list) | right (charts) */}
                <div style={{ flex: '3 1 0', minHeight: 0, display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: '1px solid #eee' }}>
                    {/* Left half */}
                    <div style={{ borderRight: '1px solid #eee', padding: '10px 12px', overflowY: 'hidden', display: 'flex', flexDirection: 'column' }}>
                        <div>
                            <div style={statRow}><span style={statLabel}>Catchment Area</span><span>{Math.round(totalArea).toLocaleString()} km²</span></div>
                            <div style={statRow}><span style={statLabel}>Catchment Population{infoTip('Data from PC-11 adjusted to 2023')}</span><span>{(totalPop / 1e6).toFixed(1)} mil</span></div>
                            <div style={statRow}><span style={statLabel}>Median Consumption{infoTip('Data from PC-11')}</span><span>{medianConsDisplay}</span></div>
                            <div style={statRow}><span style={statLabel}>Hospitals in Catchment</span><span>{otherHosp.length + 1}</span></div>
                        </div>
                        <div style={{ flex: 1, minHeight: 0, overflowY: 'scroll', marginTop: 4, background: '#f2f2f2', borderRadius: 4, padding: '4px 8px' }}>
                            {otherHosp.length === 0 && <div style={{ fontSize: 12, color: '#aaa' }}>None</div>}
                            {matchedHosp.length > 0 && <div style={subHead}>Filter Matched</div>}
                            {matchedHosp.map((h, i) => hospRow(h, `m${i}`))}
                            {filteredHosp.length > 0 && <div style={subHead}>Filtered Out</div>}
                            {filteredHosp.map((h, i) => hospRow(h, `f${i}`))}
                        </div>
                    </div>
                    {/* Right half — charts */}
                    <div style={{ display: 'flex', flexDirection: 'column', padding: '6px 8px', minWidth: 0 }}>
                        <div style={{ flex: 1, minHeight: 0 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: '#999', textTransform: 'uppercase', letterSpacing: 0.5 }}>Population by Catchment</div>
                            <div style={{ flex: 1, height: 'calc(100% - 16px)' }}><CareBandBarChart data={barData} /></div>
                        </div>
                        <div style={{ flex: 1, minHeight: 0 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: '#999', textTransform: 'uppercase', letterSpacing: 0.5 }}>Hospital Types in Catchment</div>
                            <div style={{ flex: 1, height: 'calc(100% - 16px)' }}><CatchmentTypesPieChart data={pieData} /></div>
                        </div>
                    </div>
                </div>

                {/* BOTTOM GRID — subdistrict rows */}
                <div style={{ flex: '2 1 0', minHeight: 0, overflowY: 'auto', padding: '8px 12px', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', columnGap: 16, alignContent: 'start' }}>
                    {subs.map((s, i) => {
                        const bandLight = CARE_BANDS[catchment?.bands?.[s.masterId]]?.light;
                        return (
                            <div key={i}
                                style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'center', gap: 8, fontSize: 12, color: '#222', cursor: 'pointer', background: bandLight || 'transparent', borderRadius: 3, padding: '1px 4px', marginBottom: 4 }}
                                onMouseEnter={() => hoverSubdistrict(s.masterId, true)}
                                onMouseLeave={() => hoverSubdistrict(s.masterId, false)}>
                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{s.name}</span>
                                <span style={{ fontWeight: 600, color: '#444', whiteSpace: 'nowrap', textAlign: 'right' }}>{s.pop ? s.pop.toLocaleString() : '—'}</span>
                            </div>
                        );
                    })}
                </div>
            </div>
        );
    };

    // ── Compare-tab dashboard body ───────────────────────────────────────────────

    const renderCompareTab = () => {
        const bandMeta = CARE_BANDS.map((b, i) => ({ key: `b${i}`, color: b.color, label: b.label }));
        // Always order the list by total catchment population (descending).
        const sortedCatchments = [...compareCatchments].sort(
            (a, b) => bandPopulation(b.catchment).reduce((s, v) => s + v, 0) - bandPopulation(a.catchment).reduce((s, v) => s + v, 0)
        );
        const popRows = sortedCatchments.map(c => {
            const sums = bandPopulation(c.catchment);
            return { id: c.id, name: c.name, color: c.color, b0: sums[0], b1: sums[1], b2: sums[2], b3: sums[3] };
        });
        const popTotalRows = sortedCatchments.map(c => ({
            id: c.id, name: c.name, color: c.color, value: bandPopulation(c.catchment).reduce((s, v) => s + v, 0),
        }));
        const consRows = sortedCatchments.map(c => ({
            id: c.id, name: c.name, color: c.color, value: catchmentMedianConsumption(c.catchment) ?? 0,
        }));
        const fmtRupee = (v) => (v == null ? '—' : `₹${Math.round(v).toLocaleString('en-IN')}`);
        const usePie = compareCatchments.length > COMPARE_PIE_THRESHOLD;
        const isPop = compareMetric === 'population';
        const fmt = isPop ? undefined : fmtRupee; // population uses the chart's default fmtPop
        const metricBtn = (active) => ({
            flex: 1, padding: '6px 0', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600,
            border: `1px solid ${UI_COLOR}`,
            background: active ? UI_COLOR : '#fff',
            color: active ? '#fff' : UI_COLOR,
        });
        let chart;
        if (usePie) {
            // Too many to label on an axis — pie of totals, hospital shown on hover.
            chart = (
                <div style={{ flex: 1, minHeight: 200 }}>
                    <ComparePie rows={isPop ? popTotalRows : consRows} valueFormatter={fmt} onRowHover={setHoverCompareId} />
                </div>
            );
        } else if (isPop) {
            chart = <CompareStackedBar rows={popRows} bandMeta={bandMeta} onRowHover={setHoverCompareId} />;
        } else {
            chart = <CompareMetricBar rows={consRows} valueFormatter={fmtRupee} onRowHover={setHoverCompareId} />;
        }
        return (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '10px 12px', overflowY: 'auto' }}>
                <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                    <button style={metricBtn(isPop)} onClick={() => setCompareMetric('population')}>Population</button>
                    <button style={metricBtn(!isPop)} onClick={() => setCompareMetric('consumption')}>Median Consumption</button>
                </div>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#999', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    {isPop ? (usePie ? 'Total Population' : 'Population By Catchment') : 'Median Consumption'}
                </div>
                {chart}
                <div style={{ marginTop: 'auto', fontSize: 11, color: '#777', paddingTop: 8 }}>
                    Click hospitals to add or remove catchments.
                </div>
            </div>
        );
    };

    // ── Render ─────────────────────────────────────────────────────────────────

    const tabBtnStyle = (active) => ({
        flex: 1, padding: '8px 0', border: 'none', cursor: 'pointer',
        marginBottom: 0, textAlign: 'center',
        background: active ? '#fff' : '#ededed',
        color: active ? '#111' : '#777',
        borderBottom: active ? `2px solid ${UI_COLOR}` : '2px solid transparent',
    });

    // Horizontal pill shown when a panel is collapsed. `side` = which screen edge it
    // hugs ('left' | 'right').
    const reopenTabStyle = (side) => ({
        position: 'absolute', zIndex: 1000,
        padding: '8px 14px', border: 'none',
        borderRadius: side === 'right' ? '8px 0 0 8px' : '0 8px 8px 0',
        background: UI_COLOR, color: '#fff', cursor: 'pointer', fontSize: 13,
        display: 'flex', alignItems: 'center', gap: 6,
        boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
    });

    // Collapse handle that reads as a tab extending out of a panel's edge. It sits
    // just *behind* the panel (lower z-index) so the panel's own rounded corner +
    // shadow overlap its inner edge, making it look attached rather than floating.
    const collapseTabStyle = (extra) => ({
        position: 'absolute', zIndex: 1001,
        width: 22, height: 48, border: 'none',
        background: '#fff', color: '#111', cursor: 'pointer', fontSize: 15,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        ...extra,
    });

    // ── Navbar place search (Photon geocoder) ───────────────────────────────────
    // Debounced as-you-type autocomplete; selecting a result flies the map there.
    const onSearchChange = (val) => {
        setPlaceQuery(val);
        if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
        const q = val.trim();
        if (q.length < 2) { setPlaceResults([]); return; }
        searchDebounceRef.current = setTimeout(async () => {
            searchAbortRef.current?.abort();
            const ctrl = new AbortController();
            searchAbortRef.current = ctrl;
            try { setPlaceResults(await searchPlaces(q, ctrl.signal)); }
            catch (e) { if (e.name !== 'AbortError') setPlaceResults([]); }
        }, 300);
    };

    const handlePlaceSelect = (r) => {
        if (!r) return;
        setPlaceQuery('');
        setPlaceResults([]);
        const map = mapRef.current;
        if (!map) return;
        if (r.extent) {                              // [west, north, east, south]
            const [w, n, e, s] = r.extent;
            map.flyToBounds([[s, w], [n, e]], { padding: [40, 40], duration: 1.2 });
        } else {
            map.flyTo([r.lat, r.lon], 13, { duration: 1.2 }); // note [lat, lon] order
        }
    };

    // ── Active-catchment hospital markers (circle → pin) ─────────────────────────
    // Coordinate keys of the hospital(s) whose catchment is currently drawn: the
    // single active one in stats mode, or all selected ones in compare mode.
    const coordKey = (lng, lat) => `${(+lng).toFixed(5)},${(+lat).toFixed(5)}`;
    const catchmentHospitalKeys = new Set();
    if (dashboardTab === 'compare') {
        compareCatchments.forEach((c) => { if (c.lng != null) catchmentHospitalKeys.add(coordKey(c.lng, c.lat)); });
    } else if (catchment && activeHospitalRef.current) {
        const a = activeHospitalRef.current;
        catchmentHospitalKeys.add(coordKey(a.lng, a.lat));
    }
    catchmentKeysRef.current = catchmentHospitalKeys;

    // Coordinate key of the compare row currently hovered in the chart (highlight its pin).
    const hoverCompare = hoverCompareId ? compareCatchments.find((c) => c.id === hoverCompareId) : null;
    const hoverCoordKey = hoverCompare && hoverCompare.lng != null ? coordKey(hoverCompare.lng, hoverCompare.lat) : null;

    // Swap base-hospital circle markers to pins (and back) when their catchment is
    // active. Base markers are plain Leaflet layers, so update them imperatively.
    useEffect(() => {
        // Close any open subdistrict tooltip (e.g. opened from a dashboard-row hover
        // whose mouseout never fired because the list re-rendered) so it can't stick.
        subLayerRef.current.forEach((entry) => entry?.layer?.closeTooltip?.());
        hospLayerRef.current.forEach((layer) => {
            // setIcon replaces the marker's DOM element, orphaning the tooltip's
            // mouseout listener — close any open tooltip so it can't get stuck.
            layer?.closeTooltip?.();
            const f = layer?.feature; // only base GeoJSON layers carry .feature
            if (!f) return;
            const [lng, lat] = f.geometry.coordinates;
            const key = coordKey(lng, lat);
            if (catchmentHospitalKeys.has(key)) {
                const hovered = key === hoverCoordKey;
                layer.setIcon(hovered ? baseHospitalPinBig : baseHospitalPin);
                layer.setZIndexOffset?.(hovered ? 1200 : 1100);
            } else {
                const active = isHospitalActive(f);
                layer.setIcon(active ? baseHospitalIcon : baseHospitalIconSmall);
                layer.setZIndexOffset?.(active ? 1000 : 0);
            }
        });
    }, [catchment, compareCatchments, dashboardTab, computeId, hoverCompareId]);

    return (
        <div className={[rightCollapsed ? '' : 'right-panel-open', activeToolMode === 'add' ? 'cursor-add' : ''].filter(Boolean).join(' ')} style={{ height: '100vh', width: '100vw', position: 'relative', overflow: 'hidden' }}>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }
                .leaflet-container { background: #fff !important; }
                .hosp-tip { background: rgba(17,17,17,0.7); color: #fff; border: none; border-radius: 5px; box-shadow: 0 1px 5px rgba(0,0,0,0.4); text-align: center; font-weight: 500; }
                .hosp-tip.leaflet-tooltip-top::before { border-top-color: rgba(17,17,17,0.7); }
                .info-tip { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 13px; height: 13px; margin-left: 4px; border-radius: 50%; background: #fff; color: ${UI_COLOR_LIGHT}; border: 1px solid ${UI_COLOR_LIGHT}; font-size: 9px; font-weight: 700; vertical-align: middle; cursor: default !important; user-select: none !important; -webkit-user-select: none !important; -moz-user-select: none !important; -ms-user-select: none !important; }
                .info-tip * { user-select: none !important; -webkit-user-select: none !important; }
                .info-tip .info-bubble { position: absolute; left: calc(100% + 8px); top: 50%; transform: translateY(-50%); white-space: nowrap; background: #fff; color: #111; border: 1.5px solid #111; border-radius: 8px; padding: 6px 10px; font-size: 11px; font-weight: 500; box-shadow: 0 2px 8px rgba(0,0,0,0.15); opacity: 0; visibility: hidden; transition: opacity 0.12s; z-index: 2000; pointer-events: none; }
                .info-tip:hover .info-bubble { opacity: 1; visibility: visible; }
                .filter-chk { appearance: none; -webkit-appearance: none; -moz-appearance: none; width: 15px; height: 15px; margin: 0; flex: none; border: 1.5px solid ${UI_COLOR}; border-radius: 3px; background: #fff; cursor: pointer; position: relative; }
                .filter-chk:checked { background: ${UI_COLOR}; }
                .filter-chk:checked::after { content: ''; position: absolute; left: 4px; top: 1px; width: 3px; height: 7px; border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg); }
                .info-bubble::before { content: ''; position: absolute; right: 100%; top: 50%; transform: translateY(-50%); border: 6px solid transparent; border-right-color: #111; }
                .info-bubble::after { content: ''; position: absolute; right: 100%; top: 50%; transform: translateY(-50%); border: 5px solid transparent; border-right-color: #fff; margin-right: -1px; }
                .fat-slider { position: relative; height: 28px; }
                .fat-slider input[type=range] { -webkit-appearance: none; appearance: none; width: 100%; height: 28px; margin: 0; padding: 0; border-radius: 6px; outline: none; cursor: pointer; }
                .fat-slider input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 14px; height: 28px; border-radius: 4px; background: ${UI_COLOR}; border: 2px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.4); cursor: ew-resize; }
                .fat-slider input[type=range]::-moz-range-thumb { width: 14px; height: 28px; border-radius: 4px; background: ${UI_COLOR}; border: 2px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.4); cursor: ew-resize; }
                .fat-slider-overlay { position: absolute; inset: 0; display: flex; justify-content: space-between; align-items: center; padding: 0 10px; font-size: 12px; font-weight: 600; color: #000000; pointer-events: none; }
                /* Keep the map attribution clear of the right controls panel when open. */
                .right-panel-open .leaflet-bottom.leaflet-right { margin-right: ${RIGHT_WIDTH}px; transition: margin-right 0.2s; }
                .cursor-add .leaflet-container, .cursor-add .leaflet-grab, .cursor-add .leaflet-interactive, .cursor-add .leaflet-marker-icon { cursor: ${ADD_CURSOR} !important; }`}</style>

            {/* Transient toast message */}
            {toast && (
                <div style={{
                    position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                    zIndex: 5000, background: 'rgba(17,17,17,0.92)', color: '#fff',
                    padding: '12px 24px', borderRadius: 20, fontSize: 14, fontWeight: 600,
                    boxShadow: '0 2px 10px rgba(0,0,0,0.3)', pointerEvents: 'none',
                }}>
                    {toast}
                </div>
            )}

            {/* Filtered-out notice — centered lightbox */}
            {filteredOutNotice && (
                <div style={{
                    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
                    zIndex: 4000, display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                    <div style={{
                        background: 'white', borderRadius: 10, padding: '24px 28px', width: 360,
                        boxShadow: '0 4px 20px rgba(0,0,0,0.3)', textAlign: 'center',
                    }}>
                        <div style={{ fontSize: 15, color: '#222', marginBottom: 20 }}>
                            The selected hospital was filtered out
                        </div>
                        <button
                            onClick={() => {
                                setFilteredOutNotice(false);
                                activeHospitalRef.current = null;
                                activeCatchmentKeyRef.current = null;
                                setCatchment(null);
                            }}
                            style={{
                                padding: '7px 28px', borderRadius: 20, border: 'none',
                                background: '#111', color: 'white', cursor: 'pointer',
                                fontSize: 13, fontWeight: 600,
                            }}
                        >
                            OK
                        </button>
                    </div>
                </div>
            )}

            {/* Full-screen loading overlay during initial data fetch */}
            {isLoading && (
                <div style={{
                    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
                    display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center',
                    zIndex: 10000, color: '#fff', gap: 16,
                }}>
                    <div style={{
                        width: 48, height: 48,
                        border: '4px solid rgba(255,255,255,0.3)',
                        borderTopColor: '#fff', borderRadius: '50%',
                        animation: 'spin 0.8s linear infinite',
                    }} />
                    <div style={{ fontSize: 15, opacity: 0.9 }}>Loading spatial data…</div>
                </div>
            )}

            {/* Computing overlay — same layout as the initial load, lighter backdrop */}
            {(isComputing || catchmentLoading || stateBoundaryLoading) && !isLoading && (
                <div style={{
                    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)',
                    display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center',
                    zIndex: 10000, color: '#fff', gap: 16,
                }}>
                    <div style={{
                        width: 48, height: 48,
                        border: '4px solid rgba(255,255,255,0.3)',
                        borderTopColor: '#fff', borderRadius: '50%',
                        animation: 'spin 0.8s linear infinite',
                    }} />
                    <div style={{ fontSize: 15, opacity: 0.9 }}>{stateBoundaryLoading ? 'Loading spatial data…' : 'Computing…'}</div>
                </div>
            )}

            {/* Navbar */}
            <div style={{
                position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1100,
                background: UI_COLOR, height: 50,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: 0,
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <img src={`${import.meta.env.BASE_URL}logo.jpg`} alt="Hosmac"
                        onClick={() => window.open('https://www.hosmac.com/', '_blank', 'noopener')}
                        style={{ height: 50, width: 'auto', display: 'block', cursor: 'pointer' }} />
                    <span style={{ color: 'white', fontWeight: 700, fontSize: 18, letterSpacing: 0.3 }}>
                        Urban Health Data Platform <span style={{ fontSize: 12, fontWeight: 600 }}>v0.1</span>
                    </span>
                </div>
                <span style={{
                    position: 'absolute', left: '50%', transform: 'translateX(-50%)',
                    color: 'white', fontWeight: 700, fontSize: 18, letterSpacing: 0.3,
                    pointerEvents: 'none',
                }}>
                    Cancer Hospital Catchments By Road
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
                    {[
                        { label: 'how to use', onClick: () => onOpenSplash?.('howto') },
                        { label: 'how it works', onClick: () => onOpenSplash?.('howitworks') },
                        { label: 'about', onClick: () => onOpenSplash?.('about') },
                    ].map(link => (
                        <a key={link.label} href="#"
                            onClick={e => { e.preventDefault(); link.onClick(); }}
                            style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13, textDecoration: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                            {link.label}
                        </a>
                    ))}
                    {/* Place search — width matches the right controls panel */}
                    <div style={{ position: 'relative', width: RIGHT_WIDTH, flexShrink: 0 }}>
                        <input
                            type="text"
                            value={placeQuery}
                            onChange={e => onSearchChange(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') handlePlaceSelect(placeResults[0]); }}
                            placeholder="Search places…"
                            style={{
                                width: '100%', height: 32, boxSizing: 'border-box',
                                borderRadius: 3, border: 'none', padding: '0 10px',
                                fontSize: 13, outline: 'none', background: '#fff', color: '#111',
                            }}
                        />
                        {placeResults.length > 0 && (
                            <div style={{
                                position: 'absolute', top: 36, left: 0, width: '100%', zIndex: 1200,
                                background: '#fff', borderRadius: 6, boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
                                overflow: 'hidden', maxHeight: 320, overflowY: 'auto',
                            }}>
                                {placeResults.map((r) => (
                                    <div key={r.key}
                                        onMouseDown={() => handlePlaceSelect(r)}
                                        style={{
                                            padding: '8px 10px', cursor: 'pointer', fontSize: 13, color: '#111',
                                            borderBottom: '1px solid #f0f0f0',
                                        }}
                                        onMouseEnter={e => (e.currentTarget.style.background = '#f5f5f5')}
                                        onMouseLeave={e => (e.currentTarget.style.background = '#fff')}>
                                        <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {r.primary}
                                        </div>
                                        {r.secondary && (
                                            <div style={{ fontSize: 11, color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {r.secondary}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* ── LEFT DASHBOARD PANEL (separate div, top 3/5) ── */}
            {dashCollapsed ? (
                <button
                    onClick={() => setDashCollapsed(false)}
                    style={{ ...reopenTabStyle('left'), top: 60, left: 0 }}
                    title="Show dashboard"
                >
                    ▸ Dashboard
                </button>
            ) : (
                <>
                    <div style={{
                        position: 'absolute', top: 58, left: 8, width: LEFT_WIDTH, height: DASH_HEIGHT, zIndex: 1000,
                        display: 'flex', flexDirection: 'column', background: '#fff', borderRadius: 10,
                        boxShadow: '0 4px 18px rgba(0,0,0,0.25)', overflow: 'hidden', boxSizing: 'border-box',
                    }}>
                        <div style={{ display: 'flex', alignItems: 'stretch', borderBottom: '1px solid #eee' }}>
                            <button className="panel-subtitle" style={tabBtnStyle(dashboardTab === 'stats')} onClick={() => switchTab('stats')}>Statistics</button>
                            <button className="panel-subtitle" style={tabBtnStyle(dashboardTab === 'compare')} onClick={() => switchTab('compare')}>Compare</button>
                        </div>
                        {dashboardTab === 'stats' ? renderStatsTab() : renderCompareTab()}
                    </div>
                    <button
                        onClick={() => setDashCollapsed(true)}
                        style={collapseTabStyle({ top: 72, left: `calc(8px + ${LEFT_WIDTH})`, borderRadius: '0 10px 10px 0', boxShadow: '3px 2px 8px rgba(0,0,0,0.18)' })}
                        title="Hide dashboard"
                    >◂</button>
                </>
            )}

            {/* ── LEFT EDIT PANEL (separate div, bottom) ── */}
            {editCollapsed ? (
                <button
                    onClick={() => setEditCollapsed(false)}
                    style={{ ...reopenTabStyle('left'), bottom: 16, left: 0 }}
                    title="Show interact"
                >
                    ▸ Editor
                </button>
            ) : (
                <>
                <div style={{
                    position: 'absolute', bottom: 8, left: 8, width: LEFT_WIDTH, height: EDIT_HEIGHT, zIndex: 1000,
                    background: '#fff', borderRadius: 10, boxShadow: '0 4px 18px rgba(0,0,0,0.25)',
                    padding: '12px 14px', overflow: 'hidden', boxSizing: 'border-box',
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <div className="panel-title">Hospital Editor</div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6 }}>
                        {['add', 'move', 'edit', 'delete'].map(mode => {
                            const active = activeToolMode === mode;
                            let style = { ...toolBtnStyle(active), width: '100%' };
                            if (mode === 'delete') {
                                style = active
                                    ? { ...style, border: '1px solid #a01919', background: '#a01919', color: '#fff', fontWeight: 600 }
                                    : { ...toolBtnStyle(false), width: '100%', border: '1px solid #f3b5b5', background: '#fdeaea', color: '#c0392b' };
                            }
                            return (
                                <button key={mode} style={style} onClick={() => setTool(mode)}>
                                    {mode.charAt(0).toUpperCase() + mode.slice(1)}
                                </button>
                            );
                        })}
                        <button style={{ ...toolBtnStyle(false), width: '100%' }} onClick={() => importInputRef.current?.click()}>Import</button>
                        <button style={{ ...toolBtnStyle(false), width: '100%' }} onClick={handleExport}>Export</button>
                        <input ref={importInputRef} type="file" accept=".geojson" style={{ display: 'none' }} onChange={handleImport} />
                    </div>
                    {activeToolMode && (
                        <div style={{ marginTop: 10, fontSize: 11, color: '#555', background: '#f6f6f6', borderRadius: 4, padding: '6px 10px' }}>
                            {activeToolMode === 'add'    && 'Click on the map to place a hospital'}
                            {activeToolMode === 'move'   && 'Drag a user hospital to reposition it'}
                            {activeToolMode === 'edit'   && 'Click a user hospital to edit its properties'}
                            {activeToolMode === 'delete' && 'Click a user hospital to remove it'}
                        </div>
                    )}
                </div>
                <button
                    onClick={() => { setEditCollapsed(true); setActiveToolMode(null); }}
                    style={collapseTabStyle({ bottom: 16, left: `calc(8px + ${LEFT_WIDTH})`, borderRadius: '0 10px 10px 0', boxShadow: '3px 2px 8px rgba(0,0,0,0.18)' })}
                    title="Hide interact"
                >◂</button>
                </>
            )}

            {/* ── RIGHT PANEL (basemap / filters / legend) ── */}
            {rightCollapsed ? (
                <button
                    onClick={() => setRightCollapsed(false)}
                    style={{ ...reopenTabStyle('right'), top: 60, right: 0 }}
                    title="Show controls"
                >
                    ◂ Controls
                </button>
            ) : (
                <>
                <div style={{
                    position: 'absolute', top: 50, right: 0, bottom: 0, width: RIGHT_WIDTH, zIndex: 1000,
                    background: '#fff', boxShadow: '-4px 0 18px rgba(0,0,0,0.18)',
                    display: 'flex', flexDirection: 'column', padding: 14, gap: 16, overflowY: 'auto', boxSizing: 'border-box',
                }}>

                    {/* Basemap changer — horizontal */}
                    <div>
                        <div className="panel-title">Basemap</div>
                        <div style={{ display: 'flex', flexDirection: 'row', gap: 6 }}>
                            {Object.entries(BASEMAPS).map(([key, bm]) => {
                                const isActive = basemap === key;
                                return (
                                    <button key={key} title={bm.name} onClick={() => setBasemap(key)}
                                        style={{
                                            flex: 1, height: 38, borderRadius: 8,
                                            background: isActive ? UI_COLOR : UI_COLOR_LIGHT,
                                            border: isActive ? '2px solid white' : '2px solid transparent',
                                            boxShadow: isActive ? `0 0 0 2px ${UI_COLOR}` : '0 2px 6px rgba(0,0,0,0.25)',
                                            color: 'white', fontWeight: 700, fontSize: 11, cursor: 'pointer',
                                        }}>
                                        {bm.label}
                                    </button>
                                );
                            })}
                        </div>
                        {/* Basemap transparency — label + value live inside the slider body */}
                        <div className="fat-slider" style={{ marginTop: 10 }}>
                            <input type="range" min="0" max="1" step="0.05"
                                value={1 - tileOpacity}
                                onChange={e => setTileOpacity(1 - Number(e.target.value))}
                                style={{ background: `linear-gradient(to right, ${UI_COLOR_LIGHT} ${Math.round((1 - tileOpacity) * 100)}%, #e2e8f0 ${Math.round((1 - tileOpacity) * 100)}%)` }} />
                            <div className="fat-slider-overlay">
                                <span>Transparency</span>
                                <span>{Math.round((1 - tileOpacity) * 100)}%</span>
                            </div>
                        </div>
                    </div>

                    {/* Filters — small toggle buttons styled like the basemap buttons */}
                    <div>
                        <div className="panel-title">Hospital Filter</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {hospitalTypes.map(type => (
                                <label key={type} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer', color: '#111' }}>
                                    <input type="checkbox" className="filter-chk" checked={visibleTypes.has(type)} onChange={() => toggleType(type)} />
                                    {typeLabel(type)}
                                </label>
                            ))}
                        </div>
                    </div>

                    {/* Administrative boundary overlays */}
                    <div>
                        <div className="panel-title">Admin Boundaries</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer', color: '#111' }}>
                                <input type="checkbox" className="filter-chk" checked={showStateBoundary} onChange={toggleStateBoundary} />
                                State Boundary
                            </label>
                        </div>
                    </div>

                    {/* Legend + Voronoi toggle — pinned to the bottom of the panel */}
                    <div style={{ marginTop: 'auto', marginBottom: 0 }}>
                        {SHOW_VORONOI_BUTTON && (
                        <button onClick={toggleVoronoi}
                            style={{
                                width: '100%', padding: '7px 12px', borderRadius: 6, cursor: 'pointer',
                                fontSize: 12, fontWeight: 600, marginBottom: 10,
                                border: showVoronoi ? 'none' : '1px solid #ccc',
                                background: showVoronoi ? '#e64980' : 'white',
                                color: showVoronoi ? 'white' : '#333',
                            }}>
                            {showVoronoi ? 'Hide Voronoi' : 'View Voronoi'}
                        </button>
                        )}
                        <div className="panel-title">Map Legend</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                            <span style={{ display: 'inline-block', width: 10, height: 10, flexShrink: 0, background: EXISTING_HOSP_COLOR, border: `${HOSP_STROKE_WIDTH}px solid ${EXISTING_HOSP_STROKE}`, borderRadius: '50%', boxShadow: '0 1px 3px rgba(0,0,0,0.4)' }} />
                            <span style={{ fontSize: 12, color: '#111' }}>Existing Hospital</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                            <span style={{ display: 'inline-block', width: 10, height: 10, flexShrink: 0, background: USER_HOSP_COLOR, border: `${HOSP_STROKE_WIDTH}px solid ${USER_HOSP_STROKE}`, borderRadius: '50%', boxShadow: '0 1px 3px rgba(0,0,0,0.4)' }} />
                            <span style={{ fontSize: 12, color: '#111' }}>User Added Hospital</span>
                        </div>
                        {activeFunction === 'carepathway' && (
                            <>
                                <hr style={{ border: 'none', borderTop: '1px solid #e8e8e8', margin: '8px 0' }} />
                                <div className="panel-title">Carepathways</div>
                                {CARE_BANDS.map(({ color, label }) => (
                                    <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                                        <span style={{ display: 'inline-block', width: 28, height: 4, background: color, borderRadius: 2, flexShrink: 0 }} />
                                        <span style={{ fontSize: 12, color: '#111' }}>{label}</span>
                                    </div>
                                ))}
                            </>
                        )}
                    </div>
                </div>
                <button
                    onClick={() => setRightCollapsed(true)}
                    style={collapseTabStyle({ top: 72, right: `${RIGHT_WIDTH}px`, borderRadius: '10px 0 0 10px', boxShadow: '-3px 2px 8px rgba(0,0,0,0.18)' })}
                    title="Hide controls"
                >▸</button>
                </>
            )}

            {/* Map */}
            <MapContainer
                ref={mapRef}
                bounds={INDIA_BOUNDS}
                zoomControl={false}
                style={{ height: '100%', width: '100%', background: '#fff' }}
            >
                <MapClickHandler activeToolMode={activeToolMode} onAddClick={handleAddClick} />
                <ZoomLogger onZoom={setMapZoom} />

                <TileLayer
                    key={basemap}
                    url={BASEMAPS[basemap].url}
                    attribution={BASEMAPS[basemap].attribution}
                    opacity={tileOpacity}
                />

                {/* City labels — in a top pane above the care pathways, past a zoom threshold */}
                <LabelsPane />
                {mapZoom >= CITY_LABEL_MIN_ZOOM && (
                    <TileLayer
                        key="city-labels"
                        pane="city-labels"
                        url={basemap === 'satellite' ? CITY_LABELS.dark : CITY_LABELS.light}
                        attribution={CITY_LABELS.attribution}
                        subdomains="abcd"
                    />
                )}

                {/* State boundaries — reference outlines, non-interactive */}
                {showStateBoundary && stateBoundaries && (
                    <GeoJSON
                        key="state-boundaries"
                        data={stateBoundaries}
                        interactive={false}
                        style={{ color: '#313131', weight: 4, fill: false, fillOpacity: 0 }}
                        renderer={L.canvas({ padding: 0.5 })}
                    />
                )}

                {/* Voronoi catchments — debug overlay, bottom-most */}
                {showVoronoi && computedOutputs.voronoi && (
                    <GeoJSON
                        key={`voronoi-${computeId}`}
                        data={computedOutputs.voronoi}
                        style={{ color: '#e64980', weight: 1, fillColor: '#e64980', fillOpacity: 0.05 }}
                        renderer={L.canvas({ padding: 0.5 })}
                    />
                )}

                {/* Subdistrict POI points — shown with the Voronoi debug overlay */}
                {showVoronoi && subdistricts && (
                    <GeoJSON
                        key="poi-points"
                        data={subdistricts}
                        pointToLayer={(f, ll) => L.circleMarker(ll, {
                            radius: 2, color: '#c2255c', weight: 1, fillColor: '#e64980', fillOpacity: 0.85,
                        })}
                        renderer={L.canvas({ padding: 0.5 })}
                    />
                )}

                {/* Base road network — below care pathway & hospitals (connectors hidden) */}
                {roads && (
                    <GeoJSON
                        key="base-roads"
                        data={roads}
                        filter={(f) => !f.properties?.is_connector}
                        style={{ color: '#9aa0a6', weight: 0.7 }}
                        renderer={L.canvas({ padding: 0.5 })}
                    />
                )}

                {/* Care pathway — canvas renderer avoids 100k+ SVG DOM elements */}
                {computedOutputs.carepathway && (
                    <GeoJSON
                        key={`path-${computeId}`}
                        ref={carepathwayRef}
                        data={computedOutputs.carepathway}
                        style={carepathwayStyle}
                        renderer={L.canvas({ padding: 0.5 })}
                    />
                )}

                {/* Catchment (stats mode) — translucent subdistricts + dark dissolved outline */}
                {dashboardTab === 'stats' && catchment && (
                    <>
                        <GeoJSON
                            key={`subs-${activeCatchmentKeyRef.current}`}
                            data={catchment.subdistricts}
                            style={subdistrictStyle}
                            onEachFeature={(f, layer) => {
                                const name = f.properties?.subdistrict_name || 'Subdistrict';
                                if (f.properties?.master_id != null) subLayerRef.current.set(f.properties.master_id, { layer, feature: f });
                                layer.bindTooltip(name, { sticky: true, opacity: 0.95 });
                                layer.on({
                                    mouseover: (e) => e.target.setStyle(SUBDISTRICT_HOVER_STYLE),
                                    mouseout:  (e) => { e.target.setStyle(subdistrictStyle(f)); e.target.closeTooltip?.(); },
                                });
                            }}
                        />
                        <GeoJSON
                            key={`catchment-${activeCatchmentKeyRef.current}`}
                            data={catchment.outline}
                            style={{ color: '#000', weight: 5, fill: false }}
                            interactive={false}
                        />
                    </>
                )}

                {/* Compare mode — every selected catchment, colour-coded */}
                {dashboardTab === 'compare' && compareCatchments.map((c) => {
                    const compareStyle = (f) => {
                        const band = CARE_BANDS[c.catchment.bands?.[f.properties?.master_id]];
                        return { color: band?.color || '#888', weight: 1, fillColor: band?.light || '#dddddd', fillOpacity: 0.55 };
                    };
                    return (
                    <React.Fragment key={c.id}>
                        <GeoJSON
                            key={`csubs-${c.id}`}
                            data={c.catchment.subdistricts}
                            style={compareStyle}
                            onEachFeature={(f, layer) => {
                                const name = f.properties?.subdistrict_name || 'Subdistrict';
                                layer.bindTooltip(name, { sticky: true, opacity: 0.95 });
                                layer.on({
                                    mouseover: (e) => e.target.setStyle(SUBDISTRICT_HOVER_STYLE),
                                    mouseout:  (e) => { e.target.setStyle(compareStyle(f)); e.target.closeTooltip?.(); },
                                });
                            }}
                        />
                        <GeoJSON
                            key={`couline-${c.id}`}
                            data={c.catchment.outline}
                            style={{ color: '#000', weight: 7, fill: false }}
                            interactive={false}
                        />
                    </React.Fragment>
                    );
                })}

                {/* Hovered compare row → its catchment outline in its unique colour, on top */}
                {dashboardTab === 'compare' && hoverCompare && (
                    <GeoJSON
                        key={`chl-${hoverCompare.id}`}
                        data={hoverCompare.catchment.outline}
                        style={{ color: hoverCompare.color, weight: 9, fill: false }}
                        interactive={false}
                    />
                )}

                {/* Base hospitals — rendered above carepathway */}
                {displayedHospitals && (
                    <GeoJSON
                        key={`hosp-${displayedHospitals.features.length}-${[...visibleTypes].sort().join(',')}-${EXISTING_HOSP_COLOR}-${EXISTING_HOSP_STROKE}-${HOSP_STROKE_WIDTH}`}
                        data={displayedHospitals}
                        pointToLayer={(f, ll) => {
                            const active = isHospitalActive(f);
                            return L.marker(ll, {
                                icon: active ? baseHospitalIcon : baseHospitalIconSmall,
                                zIndexOffset: active ? 1000 : 0,
                            });
                        }}
                        onEachFeature={(f, layer) => {
                            const name = f.properties?.name || 'Unknown';
                            const type = f.properties?.['Hospital Type'] || 'No Data';
                            const [hlng, hlat] = f.geometry.coordinates;
                            hospLayerRef.current.set(coordKey(hlng, hlat), layer);
                            layer.bindTooltip(`<b>${name}</b><br/>${type}`, { direction: 'top', offset: [0, -6], opacity: 1, className: 'hosp-tip' });
                            layer.on('contextmenu', (e) => {
                                L.DomEvent.preventDefault(e);
                                L.DomEvent.stopPropagation(e);
                                const link = f.properties?.Links;
                                if (link) window.open(link, '_blank', 'noopener');
                                else showToast('No link available for this hospital');
                            });
                            layer.on('click', () => {
                                const mode = activeToolModeRef.current;
                                if (mode === 'move' || mode === 'edit' || mode === 'delete') {
                                    const verb = { move: 'moved', edit: 'edited', delete: 'deleted' }[mode];
                                    showToast(`Existing hospital cannot be ${verb}`);
                                    return;
                                }
                                if (mode) return;
                                if (isHospitalActive(f)) {
                                    const [lng, lat] = f.geometry.coordinates;
                                    handleHospitalClick(lng, lat, f.properties?.name, f.properties?.subdistrict, f.properties?.['Hospital Type'], false);
                                } else {
                                    showToast('This hospital is filtered out');
                                }
                            });
                        }}
                    />
                )}

                {/* User-added hospitals — topmost layer */}
                {userAddedHospitals.map((h, idx) => {
                    const hKey = coordKey(h.geometry.coordinates[0], h.geometry.coordinates[1]);
                    const isCatchmentHosp = catchmentHospitalKeys.has(hKey);
                    const isHovered = hKey === hoverCoordKey;
                    return (
                    <Marker
                        key={idx}
                        position={[h.geometry.coordinates[1], h.geometry.coordinates[0]]}
                        draggable={activeToolMode === 'move'}
                        icon={isCatchmentHosp ? (isHovered ? userHospitalPinBig : userHospitalPin) : userHospitalIcon}
                        ref={(layer) => { if (layer) hospLayerRef.current.set(coordKey(h.geometry.coordinates[0], h.geometry.coordinates[1]), layer); }}
                        eventHandlers={{
                            mouseover: (e) => {
                                if (hospitalDraggingRef.current) return;
                                const key = coordKey(h.geometry.coordinates[0], h.geometry.coordinates[1]);
                                const isPin = catchmentKeysRef.current.has(key);
                                if (activeToolMode === 'delete') e.target.setIcon(userHospitalIconRed);
                                else if (activeToolMode === 'edit' || activeToolMode === 'move') e.target.setIcon(isPin ? userHospitalPinBig : userHospitalIconLarge);
                            },
                            mouseout: (e) => {
                                if (hospitalDraggingRef.current) return;
                                const key = coordKey(h.geometry.coordinates[0], h.geometry.coordinates[1]);
                                e.target.setIcon(catchmentKeysRef.current.has(key) ? userHospitalPin : userHospitalIcon);
                            },
                            dragstart: (e) => {
                                hospitalDraggingRef.current = true;
                                e.target._map?.getContainer().style.setProperty('cursor', 'grabbing');
                            },
                            dragend: (e) => {
                                hospitalDraggingRef.current = false;
                                e.target._map?.getContainer().style.setProperty('cursor', 'grab');
                                handleDragEnd(idx, e.target.getLatLng());
                            },
                            click: (e) => {
                                L.DomEvent.stopPropagation(e);
                                if (activeToolMode === 'delete') handleDeleteHospital(idx);
                                else if (activeToolMode === 'edit') {
                                    // Edit mode: click a user hospital to edit name/type.
                                    setDialogState({
                                        mode: 'edit', idx,
                                        latlng: { lat: h.geometry.coordinates[1], lng: h.geometry.coordinates[0] },
                                        data: { ...h.properties },
                                    });
                                } else if (activeToolMode === 'move') {
                                    // Move mode: drag only — no dialog.
                                } else {
                                    handleHospitalClick(h.geometry.coordinates[0], h.geometry.coordinates[1], h.properties.name, h.properties.subdistrict, h.properties['Hospital Type'], true);
                                }
                            },
                        }}
                    >
                        <Tooltip direction="top" offset={[0, -6]} opacity={1} className="hosp-tip">
                            <b>{h.properties.name || 'User Hospital'}</b><br />
                            {h.properties['Hospital Type'] || 'No Data'}
                        </Tooltip>
                    </Marker>
                    );
                })}
            </MapContainer>

            {/* Dialogs */}
            {dialogState && (
                <HospitalDialog
                    dialogState={dialogState}
                    onSubmit={handleDialogSubmit}
                    onClose={() => setDialogState(null)}
                />
            )}
            {functionSettingsOpen && (
                <FunctionSettingsDialog
                    activeFunction={activeFunction}
                    settings={functionSettings}
                    onSave={handleFunctionSettingsSave}
                    onClose={() => setFunctionSettingsOpen(false)}
                />
            )}
        </div>
    );
}
