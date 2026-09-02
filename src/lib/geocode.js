// Place search via Photon (Komoot) — free, no-API-key, OSM-based geocoder built
// for as-you-type autocomplete. Isolated here so the external service has a
// single swap point (mirrors how fetchSpatial.js isolates Supabase).

// India bbox: minLon,minLat,maxLon,maxLat (matches INDIA_BBOX in map.jsx).
const INDIA_BBOX = '68.135789,8.102689,97.371994,37.056175';

export async function searchPlaces(query, signal) {
    // Over-fetch, then collapse Photon's duplicate records for the same place
    // (a city often returns a node + boundary + district) down to one entry.
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}`
        + `&limit=12&lang=en&lat=22.6&lon=79&bbox=${INDIA_BBOX}`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`geocode ${res.status}`);
    const data = await res.json();
    const seen = new Set();
    const out = [];
    for (const f of data.features || []) {
        const p = f.properties || {};
        const [lon, lat] = f.geometry?.coordinates || [];
        if (lat == null || lon == null) continue;
        const parts = [p.city, p.county, p.state, p.country].filter(Boolean);
        const primary = p.name || parts[0] || 'Unknown';
        const secondary = parts.filter((s) => s !== p.name).join(', ');
        // Dedupe by place name (case-insensitive), keeping the first/most-relevant —
        // Photon returns the same place as several records (node/boundary/district).
        const dedupeKey = primary.trim().toLowerCase();
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        out.push({
            key: `${p.osm_type || ''}${p.osm_id || ''}:${lon},${lat}`,
            lon, lat,
            extent: p.extent || null,           // [west, north, east, south] when present
            primary,
            secondary,
        });
        if (out.length >= 6) break;
    }
    return out;
}
