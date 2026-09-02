import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Global toggle for all console.log output across the app. Set true to re-enable.
const DEBUG_LOGS = false
if (!DEBUG_LOGS) console.log = () => {}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
