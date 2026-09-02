import { supabase } from './supabase';

// Defensive: ensure polygon rings are closed (first === last) before handing
// geometry to turf, which rejects unclosed rings. Source data should be valid,
// but this guards against the occasional invalid/unclosed ring from imports.
function closeRing(ring) {
    if (ring.length < 3) return ring;
    const a = ring[0], b = ring[ring.length - 1];
    if (a[0] !== b[0] || a[1] !== b[1]) ring.push([a[0], a[1]]);
    return ring;
}

function closeGeometry(geom) {
    if (!geom) return geom;
    if (geom.type === 'Polygon') {
        geom.coordinates.forEach(closeRing);
    } else if (geom.type === 'MultiPolygon') {
        geom.coordinates.forEach(poly => poly.forEach(closeRing));
    }
    return geom;
}

function toFC(rows, propsFn) {
    return {
        type: 'FeatureCollection',
        features: rows.map(row => ({
            type: 'Feature',
            geometry: closeGeometry(JSON.parse(row.geometry)),
            properties: propsFn(row),
        })),
    };
}

async function fetchAll(viewName) {
    const pageSize = 1000;

    // Get the row count first so we can request every page in parallel.
    const { count, error: countErr } = await supabase
        .from(viewName)
        .select('*', { count: 'exact', head: true });
    if (countErr) throw countErr;

    // Fallback to sequential paging if the count is unavailable.
    if (count == null) {
        let from = 0, all = [];
        while (true) {
            const { data, error } = await supabase.from(viewName).select('*').range(from, from + pageSize - 1);
            if (error) throw error;
            all = all.concat(data);
            if (data.length < pageSize) break;
            from += pageSize;
        }
        return all;
    }

    const pages = Math.ceil(count / pageSize);
    const requests = [];
    for (let p = 0; p < pages; p++) {
        requests.push(
            supabase.from(viewName).select('*').range(p * pageSize, p * pageSize + pageSize - 1)
        );
    }
    const results = await Promise.all(requests);

    const all = [];
    for (const { data, error } of results) {
        if (error) throw error;
        all.push(...data);
    }
    return all;
}

export async function fetchHospitals() {
    const rows = await fetchAll('hospitals_view');
    return toFC(rows, row => ({
        name: row.name,
        'Hospital Type': row.hospital_type,
        'Bed Count': row.bed_count,
        'ICU Bed Count': row.icu_bed_count,
        'ot count': row.ot_count,
        'Doctor Count': row.doctor_count,
        'Staff Count': row.staff_count,
        city: row.city,
        state: row.state,
        subdistrict: row.subdistrict,
        Links: row.links,
        description: row.description,
        'Built up area  ( sq ft )': row.built_up_area,
        'Regional Hospital': row.regional_h,
        'Year Established': row.year_established,
        Accreditation: row.accreditation,
        'Empanelment Type': row.empanelment,
        'Radiation Oncology': row.radiation,
        'Medical Oncology': row.medical_oncology,
        'Surgical Oncology': row.surgical_oncology,
        'Medical Education': row.medical_edu,
        'Medical Research': row.medical_research,
        Mammography: row.mammography,
        'CT-Scan': row.ct_scan,
        MRI: row.mri,
        'PET-CT': row.pet_ct,
        Ultrasound: row.ultrasound,
        Brachytherapy: row.brachytherapy,
        'Palliative Care': row.palliative,
        'Bone Marrow Transplant': row.bone_marrow,
    }));
}

export async function fetchMetroRegions() {
    const rows = await fetchAll('metro_regions_view');
    return toFC(rows, row => ({ id: row.id, name: row.name }));
}

export async function fetchIndiaBoundary() {
    const rows = await fetchAll('india_boundary_view');
    // One (or more) boundary rows merged into a single Feature for clipping.
    const fc = toFC(rows, row => ({ id: row.id }));
    return fc.features.length === 1 ? fc.features[0] : fc;
}

export async function fetchPoiSubdistricts() {
    const rows = await fetchAll('poi_subdistricts_view');
    return toFC(rows, row => ({
        master_id: row.master_id,
        subdistrict_name: row.subdistrict_name,
        pc11_subdistrict_id: row.pc11_subdistrict_id,
        cons_pc_urban: row.cons_pc_urban,
        cons_pc_rural: row.cons_pc_rural,
    }));
}

export async function fetchStateBoundaries() {
    const rows = await fetchAll('state_boundary_view');
    return toFC(rows, row => ({ state_name: row.state_name }));
}

export async function fetchSubdistrictBoundaries(masterIds) {
    if (!masterIds?.length) return { type: 'FeatureCollection', features: [] };
    const chunk = 200; // keep .in() lists reasonable
    let rows = [];
    for (let i = 0; i < masterIds.length; i += chunk) {
        const { data, error } = await supabase
            .from('subdistrict_boundaries_view')
            .select('*')
            .in('master_id', masterIds.slice(i, i + chunk));
        if (error) throw error;
        rows = rows.concat(data);
    }
    return toFC(rows, row => ({
        master_id: row.master_id,
        subdistrict_name: row.subdistrict_name,
        pop_pc_total: row.pop_pc_total,
    }));
}

export async function fetchSplitRoads() {
    const rows = await fetchAll('roads_split_view');
    return {
        type: 'FeatureCollection',
        features: rows.map(row => ({
            type: 'Feature',
            geometry: JSON.parse(row.geometry),
            properties: { is_connector: row.is_connector },
        })),
    };
}
