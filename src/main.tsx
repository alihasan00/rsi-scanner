import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider, theme } from 'antd'
import './index.css'
import App from './App.tsx'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element not found')

createRoot(rootElement).render(
  <StrictMode>
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: '#29ffb8',
          colorBgContainer: '#1c212c',
          colorBgElevated: '#1c212c',
          colorBorder: '#2a3140',
          borderRadius: 10,
        },
      }}
    >
      <App />
    </ConfigProvider>
  </StrictMode>,
)
