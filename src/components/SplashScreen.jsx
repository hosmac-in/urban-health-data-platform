import React, { useState, useEffect } from 'react';

// How-to-use carousel shown over the map on first load. The map mounts
// underneath and fetches spatial data in the background while this is up.
const ABOUT_SLIDES = [
    {
        title: 'About',
        body: 'coming soon.',
    },
];

// "How it works" carousel — blank for now.
const HOW_IT_WORKS_SLIDES = [
    { title: 'How It Works', body: 'coming soon' },
];

// `image`: filename of an image in the public/ folder (e.g. 'tut1.png').
// Leave it as '' or omit it to show no image on that slide.
const SLIDES = [
    {
        title: 'Urban Health Data Platform: How To Use',
        body: '',
        image: 'tut1.png',
    },
    {
        title: 'Zoom To Location Of Interest',
        body: '',
        image: 'tut2.png',
    },
    {
        title: 'Click On Any Hospital',
        body: '',
        image: 'tut3.png',
    },
    {
        title: 'Carepathways',
        body: '',
        image: 'tut4.png',
    },
    {
        title: 'Catchment Areas',
        body: '',
        image: 'tut5.png',
    },
    {
        title: 'Dashboard Statistics',
        body: '',
        image: 'tut6.png',
    },
    {
        title: 'Dashboard Compare: Population',
        body: 'Population data used from Population Census 2011',
        image: 'tut7.png',
    },
    {
        title: 'Dashboard Compare: Median Consumption',
        body: 'Consumption data used from Population Census 2011',
        image: 'tut8.png',
    },
        {
        title: 'Hospital Editor: Add, Move & Delete',
        body: '',
        image: 'tut9.png',
    },
        {
        title: 'Hospital Editor: Analyse & Save',
        body: '',
        image: 'tut10.png',
    },
    {
        title: 'Disclaimer: The platform is for academic use only',
        body: 'Data collection and verfication is still in-process. Maps generated from this platform should not be directly used for clinical, operational, or commercial decisions.',
        notice: true,
    },
];

export default function SplashScreen({ onClose, variant = 'howto' }) {
    const slides = variant === 'about' ? ABOUT_SLIDES
        : variant === 'howitworks' ? HOW_IT_WORKS_SLIDES
        : SLIDES;
    const [index, setIndex] = useState(0);
    const [dir, setDir] = useState(1); // 1 = forward, -1 = back (drives slide direction)
    const isLast = index === slides.length - 1;
    const slide = slides[index];

    const forward = () => { setDir(1); setIndex(i => Math.min(slides.length - 1, i + 1)); };
    const back = () => { setDir(-1); setIndex(i => Math.max(0, i - 1)); };

    // Close the splash on Escape key press.
    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    return (
        <div style={styles.overlay}>
            <style>{`
                @keyframes splashInRight { from { opacity: 0; transform: translateX(40px); } to { opacity: 1; transform: translateX(0); } }
                @keyframes splashInLeft  { from { opacity: 0; transform: translateX(-40px); } to { opacity: 1; transform: translateX(0); } }
            `}</style>
            <div style={styles.card}>
                <div style={styles.slideRow}>
                    <button
                        onClick={back}
                        disabled={index === 0}
                        aria-label="Previous"
                        style={{ ...styles.arrow, ...(index === 0 ? styles.arrowDisabled : null) }}
                    >
                        {'‹'}
                    </button>

                    <div
                        key={index}
                        style={{
                            ...styles.slide,
                            animation: `${dir === 1 ? 'splashInRight' : 'splashInLeft'} 0.3s ease`,
                        }}
                    >
                        <h2 style={styles.title}>{slide.title}</h2>
                        {slide.image && (
                            <img src={`${import.meta.env.BASE_URL}${slide.image}`} alt=""
                                style={styles.slideImg} />
                        )}
                        {slide.notice ? (
                            <div style={styles.noticeSlide}>
                                <p style={{ ...styles.body, fontSize: 22, maxWidth: 640 }}>{slide.body}</p>
                            </div>
                        ) : (
                            <p style={styles.body}>{slide.body}</p>
                        )}
                    </div>

                    <button
                        onClick={forward}
                        disabled={isLast}
                        aria-label="Next"
                        style={{ ...styles.arrow, ...(isLast ? styles.arrowDisabled : null) }}
                    >
                        {'›'}
                    </button>
                </div>

                <div style={styles.dots}>
                    {slides.map((_, i) => (
                        <span
                            key={i}
                            onClick={() => { setDir(i >= index ? 1 : -1); setIndex(i); }}
                            style={{
                                ...styles.dot,
                                ...(i === index ? styles.dotActive : null),
                            }}
                        />
                    ))}
                </div>

                <div style={styles.controls}>
                    <button onClick={onClose} style={{ ...styles.btn, ...styles.btnDanger }}>
                        Skip
                    </button>
                    {isLast && (
                        <button onClick={onClose} style={{ ...styles.btn, ...styles.btnPrimary }}>
                            {variant === 'howto' ? 'Get started' : 'Close'}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

const styles = {
    overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        background: 'rgba(15, 23, 42, 0.55)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
    },
    card: {
        // ---- Splash size: edit these two values ----
        width: '90vw',
        height: '90vh',
        // --------------------------------------------
        background: '#ffffff',
        borderRadius: 16,
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        padding: '28px 28px 20px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
    },
    slideRow: {
        flex: 1,
        minHeight: 0,
        display: 'flex',
        alignItems: 'stretch',
        gap: 8,
    },
    arrow: {
        flexShrink: 0,
        alignSelf: 'center',
        width: 56,
        height: 56,
        borderRadius: '50%',
        border: 'none',
        background: 'transparent',
        color: '#2563eb',
        fontSize: 72,
        lineHeight: 1,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
    },
    arrowDisabled: {
        opacity: 0.2,
        cursor: 'not-allowed',
    },
    slide: {
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: '12px 16px',
        overflow: 'auto',
    },
    slideImg: {
        display: 'block',
        maxWidth: '100%',
        maxHeight: '80%',
        objectFit: 'contain',
        margin: '0 auto 14px',
        border: '2px solid #0f172a',
        borderRadius: 2,
    },
    noticeSlide: {
        // Fill the same area a slide image would occupy.
        flex: 1,
        minHeight: 0,
        width: '100%',
        margin: '0 auto 14px',
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#fff7ed',
        borderRadius: 12,
        border: '1px solid #fed7aa',
    },
    title: {
        margin: '0 0 14px',
        fontSize: 24,
        fontWeight: 700,
        color: '#0f172a',
    },
    body: {
        margin: 0,
        fontSize: 16,
        lineHeight: 1.55,
        color: '#475569',
        maxWidth: 420,
    },
    dots: {
        display: 'flex',
        justifyContent: 'center',
        gap: 8,
        margin: '18px 0',
    },
    dot: {
        width: 9,
        height: 9,
        borderRadius: '50%',
        background: '#cbd5e1',
        cursor: 'pointer',
        transition: 'background 0.2s',
    },
    dotActive: {
        background: '#2563eb',
    },
    controls: {
        display: 'flex',
        justifyContent: 'space-between',
        gap: 8,
    },
    btn: {
        padding: '9px 18px',
        borderRadius: 8,
        fontSize: 14,
        fontWeight: 600,
        cursor: 'pointer',
        border: '1px solid transparent',
    },
    btnPrimary: {
        background: '#2563eb',
        color: '#fff',
        marginLeft: 'auto',
    },
    btnGhost: {
        background: 'transparent',
        color: '#475569',
        border: '1px solid #e2e8f0',
    },
    btnDanger: {
        background: '#fdeaea',
        color: '#c0392b',
        border: '1px solid #f3b5b5',
    },
    btnDisabled: {
        opacity: 0.4,
        cursor: 'not-allowed',
    },
};
