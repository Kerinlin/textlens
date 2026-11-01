import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '../styles.css'
import './screenshot.css'
import { ScreenshotApp } from './ScreenshotApp'

const root = document.getElementById('root')
if (!root) throw new Error('Screenshot root element is missing')

createRoot(root).render(
  <StrictMode>
    <ScreenshotApp />
  </StrictMode>
)
