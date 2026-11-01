import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '../styles.css'
import './pin.css'
import { PinApp } from './PinApp'

const root = document.getElementById('root')
if (!root) throw new Error('Pin root element is missing')

createRoot(root).render(
  <StrictMode>
    <PinApp />
  </StrictMode>
)
