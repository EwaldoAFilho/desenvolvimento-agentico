import '@xyflow/react/dist/style.css'
import './styles.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'

const host = document.getElementById('root')
if (host === null) throw new Error('elemento #root ausente em index.html')

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
