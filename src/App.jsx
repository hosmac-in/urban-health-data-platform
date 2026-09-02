import React, { useState } from 'react';
import MapComponent from './components/map'; // Update this path if your file is named differently
import SplashScreen from './components/SplashScreen';
import './App.css'; // Optional: useful for standardizing margins/padding

export default function App() {
  // null = no splash. 'howto' = how-to-use carousel, 'about' = about page.
  const [splashView, setSplashView] = useState('howto');
  // Compute is gated until the initial how-to splash is first dismissed.
  const [computeStarted, setComputeStarted] = useState(false);

  const closeSplash = () => {
    setComputeStarted(true);
    setSplashView(null);
  };

  return (
    // We use a clean, full-viewport container so Leaflet has room to render
    <div className="app-container" style={{ width: '100vw', height: '100vh', margin: 0, padding: 0 }}>

      {/* Map mounts immediately and loads spatial data in the background
          while the how-to-use splash carousel is shown on top. Compute is
          deferred until the splash is first closed. */}
      <MapComponent computeEnabled={computeStarted} onOpenSplash={setSplashView} />

      {splashView && <SplashScreen variant={splashView} onClose={closeSplash} />}

    </div>
  );
}
