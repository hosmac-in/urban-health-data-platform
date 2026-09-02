import React from 'react';
import {
    BarChart, Bar, PieChart, Pie, XAxis, YAxis, ResponsiveContainer, LabelList, Cell, Tooltip,
} from 'recharts';

// Compact tooltip — styled small like a native button title tooltip.
const tipStyle = {
    background: 'rgba(17,17,17,0.85)', color: '#fff', border: 'none',
    borderRadius: 4, padding: '3px 7px', fontSize: 10, lineHeight: 1.3,
    boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
};
const SmallTip = ({ active, payload, labelKey, fmt = fmtPop }) => {
    if (!active || !payload || !payload.length) return null;
    return (
        <div style={tipStyle}>
            {payload.map((p, i) => (
                <div key={i}>{(p.payload?.[labelKey] ?? p.name)}: {fmt(p.value)}</div>
            ))}
        </div>
    );
};

// Colours for hospital ownership types. Anything not listed (incl. null →
// "No Data") falls back to grey.
export const OWNERSHIP_COLORS = {
    Public: '#1d6ef5',
    Private: '#e8354a',
    Trust: '#7c3aed',
    'No Data': '#9aa0a6',
};
const ownershipColor = (type) => OWNERSHIP_COLORS[type] || '#9aa0a6';

const RADIAN = Math.PI / 180;
// Render the value centred inside each pie sector.
const renderPieLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, value }) => {
    const r = innerRadius + (outerRadius - innerRadius) * 0.5;
    const x = cx + r * Math.cos(-midAngle * RADIAN);
    const y = cy + r * Math.sin(-midAngle * RADIAN);
    return (
        <text x={x} y={y} fill="#fff" fontSize={10} fontWeight={600}
            textAnchor="middle" dominantBaseline="central">{value}</text>
    );
};

const fmtPop = (v) => {
    if (v == null) return '—';
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `${Math.round(v / 1e3)}k`;
    return `${v}`;
};

// Care-band population — horizontal bars, one per band, coloured by the band
// colour. Band distance labels are intentionally hidden (shown only on hover).
// data: [{ band, pop, color }]
export function CareBandBarChart({ data }) {
    return (
        <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ top: 4, right: 28, left: 4, bottom: 4 }}>
                <XAxis type="number" tickFormatter={fmtPop} tick={{ fontSize: 9 }} />
                <YAxis type="category" dataKey="band" hide />
                <Tooltip content={<SmallTip labelKey="band" />} isAnimationActive={false} cursor={{ fill: 'rgba(0,0,0,0.05)' }} />
                <Bar dataKey="pop" isAnimationActive={false} minPointSize={3}>
                    {data.map((d, i) => <Cell key={i} fill={d.color} />)}
                    <LabelList dataKey="pop" position="right" formatter={fmtPop} style={{ fontSize: 9, fill: '#444' }} />
                </Bar>
            </BarChart>
        </ResponsiveContainer>
    );
}

// Catchment hospital types — pie of ownership types.
// data: [{ type, count }]
export function CatchmentTypesPieChart({ data }) {
    if (!data || data.length === 0) {
        return <div style={{ fontSize: 11, color: '#aaa', textAlign: 'center', paddingTop: 24 }}>No other hospitals</div>;
    }
    return (
        <ResponsiveContainer width="100%" height="100%">
            <PieChart>
                <Tooltip content={<SmallTip labelKey="type" />} isAnimationActive={false} />
                <Pie data={data} dataKey="count" nameKey="type" cx="50%" cy="50%" outerRadius="80%"
                    isAnimationActive={false}
                    label={renderPieLabel} labelLine={false}>
                    {data.map((d, i) => <Cell key={i} fill={ownershipColor(d.type)} />)}
                </Pie>
            </PieChart>
        </ResponsiveContainer>
    );
}

// Wrap a label into at most two lines (word-aware), truncating the rest with "…".
const MAX_TICK_CHARS = 22;
function wrapTwoLines(text, maxChars) {
    const words = String(text ?? '').split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    let i = 0;
    for (; i < words.length; i++) {
        const cand = cur ? `${cur} ${words[i]}` : words[i];
        if (cand.length <= maxChars) { cur = cand; }
        else {
            if (cur) lines.push(cur);
            cur = words[i];
            if (lines.length === 2) break;          // already have 2 lines; more remains
        }
    }
    if (lines.length < 2 && cur) lines.push(cur);
    const result = lines.slice(0, 2);
    // Add an ellipsis if any words didn't fit into the two lines.
    const usedWords = result.join(' ').split(/\s+/).filter(Boolean).length;
    if (usedWords < words.length) {
        let last = result[result.length - 1] || '';
        if (last.length > maxChars - 1) last = last.slice(0, maxChars - 1);
        result[result.length - 1] = `${last}…`;
    }
    // Hard-cap any single over-long word.
    return result.map((l) => (l.length > maxChars ? `${l.slice(0, maxChars - 1)}…` : l));
}

// Colour each catchment's name on the Y axis with that catchment's assigned colour.
const ColoredYTick = ({ x, y, payload, rows }) => {
    const color = rows?.[payload?.index]?.color || '#333';
    const lines = wrapTwoLines(payload?.value, MAX_TICK_CHARS);
    return (
        <text x={x} y={y} textAnchor="end" fontSize={9} fontWeight={700} fill={color}>
            {lines.map((ln, i) => (
                <tspan key={i} x={x} dy={i === 0 ? (lines.length === 2 ? -1 : 3) : 10}>{ln}</tspan>
            ))}
        </text>
    );
};

// Compare pie — used when there are too many catchments to label on an axis.
// One slice per catchment (coloured by its colour); name shown only on hover.
// rows: [{ id, name, color, value }]
export function ComparePie({ rows, valueFormatter = fmtPop, onRowHover }) {
    if (!rows || rows.length === 0) {
        return <div style={{ fontSize: 12, color: '#aaa', textAlign: 'center', paddingTop: 24 }}>Select hospitals to compare</div>;
    }
    const rowId = (d) => d?.payload?.id ?? d?.id;
    return (
        <ResponsiveContainer width="100%" height="100%">
            <PieChart>
                <Tooltip content={<SmallTip labelKey="name" fmt={valueFormatter} />} isAnimationActive={false} />
                <Pie data={rows} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius="80%"
                    isAnimationActive={false} labelLine={false}
                    onMouseEnter={(d) => onRowHover?.(rowId(d))} onMouseLeave={() => onRowHover?.(null)}>
                    {rows.map((r, i) => <Cell key={i} fill={r.color} />)}
                </Pie>
            </PieChart>
        </ResponsiveContainer>
    );
}

// Single-metric compare chart — one horizontal bar per catchment, coloured by
// that catchment's colour. rows: [{ id, name, color, value }]
export function CompareMetricBar({ rows, valueFormatter = fmtPop, onRowHover }) {
    if (!rows || rows.length === 0) {
        return <div style={{ fontSize: 12, color: '#aaa', textAlign: 'center', paddingTop: 24 }}>Select hospitals to compare</div>;
    }
    const rowId = (d) => d?.payload?.id ?? d?.id;
    return (
        <ResponsiveContainer width="100%" height={Math.max(120, rows.length * 46)}>
            <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 44, left: 0, bottom: 4 }}
                onMouseLeave={() => onRowHover?.(null)}>
                <XAxis type="number" tickFormatter={valueFormatter} tick={{ fontSize: 9 }} />
                <YAxis type="category" dataKey="name" width={120} tick={<ColoredYTick rows={rows} />} />
                <Tooltip content={<SmallTip labelKey="name" fmt={valueFormatter} />} isAnimationActive={false} cursor={{ fill: 'rgba(0,0,0,0.05)' }} />
                <Bar dataKey="value" isAnimationActive={false} minPointSize={3}
                    onMouseEnter={(d) => onRowHover?.(rowId(d))} onMouseLeave={() => onRowHover?.(null)}>
                    {rows.map((r, i) => <Cell key={i} fill={r.color} />)}
                    <LabelList dataKey="value" position="right" formatter={valueFormatter} style={{ fontSize: 9, fill: '#444' }} />
                </Bar>
            </BarChart>
        </ResponsiveContainer>
    );
}

// Stacked compare chart — one horizontal bar per catchment, care-band
// populations stacked. rows: [{ id, name, color, b0, b1, b2, b3 }]
// bandMeta: [{ key, color, label }]
export function CompareStackedBar({ rows, bandMeta, onRowHover }) {
    if (!rows || rows.length === 0) {
        return <div style={{ fontSize: 12, color: '#aaa', textAlign: 'center', paddingTop: 24 }}>Select hospitals to compare</div>;
    }
    const rowId = (d) => d?.payload?.id ?? d?.id;
    return (
        <ResponsiveContainer width="100%" height={Math.max(120, rows.length * 46)}>
            <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, left: 0, bottom: 4 }}
                onMouseLeave={() => onRowHover?.(null)}>
                <XAxis type="number" tickFormatter={fmtPop} tick={{ fontSize: 9 }} />
                <YAxis type="category" dataKey="name" width={120} tick={<ColoredYTick rows={rows} />} />
                <Tooltip content={<SmallTip labelKey="_none" />} isAnimationActive={false} cursor={{ fill: 'rgba(0,0,0,0.05)' }} />
                {bandMeta.map((b) => (
                    <Bar key={b.key} dataKey={b.key} name={b.label} stackId="a"
                        fill={b.color} isAnimationActive={false}
                        onMouseEnter={(d) => onRowHover?.(rowId(d))} onMouseLeave={() => onRowHover?.(null)} />
                ))}
            </BarChart>
        </ResponsiveContainer>
    );
}
