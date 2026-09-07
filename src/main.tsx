import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider, theme } from 'antd'
import './index.css'
import App from './App.tsx'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element not found')
document.documentElement.classList.add('dark')

createRoot(rootElement).render(
  <StrictMode>
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: '#8B46F2',
          colorPrimaryHover: '#A366F5',
          colorPrimaryActive: '#A366F5',
          colorPrimaryBg: '#261042',
          colorPrimaryBgHover: '#261042',
          colorPrimaryBorder: '#8B46F2',
          colorPrimaryText: '#8B46F2',
          colorPrimaryTextHover: '#A366F5',
          colorPrimaryTextActive: '#A366F5',
          colorLink: '#8B46F2',
          colorLinkHover: '#A366F5',
          colorLinkActive: '#A366F5',
          colorBgBase: '#0F0F0F',
          colorBgContainer: '#1A1A1A',
          colorBgElevated: '#242424',
          colorBgLayout: '#0F0F0F',
          colorBorder: '#333333',
          colorBorderSecondary: '#333333',
          colorSplit: '#333333',
          colorTextBase: '#F9F9F9',
          colorText: '#F9F9F9',
          colorTextHeading: '#F9F9F9',
          colorTextSecondary: '#D4D4D4',
          colorTextTertiary: '#888888',
          colorTextQuaternary: '#888888',
          colorTextPlaceholder: '#888888',
          colorSuccess: '#16A34A',
          colorWarning: '#D97706',
          colorError: '#DC2626',
          colorInfo: '#8B46F2',
          colorFillAlter: '#1A1A1A',
          colorFillTertiary: '#1A1A1A',
          colorFillSecondary: '#261042',
          controlItemBgActive: '#261042',
          controlItemBgActiveHover: '#261042',
          controlItemBgHover: '#242424',
          controlOutline: '#261042',
          borderRadius: 8,
          borderRadiusLG: 12,
          controlHeight: 36,
          fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          fontSize: 14,
          boxShadow: '0 4px 16px rgba(0, 0, 0, 0.2)',
          boxShadowSecondary: '0 12px 40px rgba(0, 0, 0, 0.3)',
        },
        components: {
          Button: {
            primaryShadow: 'none',
            defaultShadow: 'none',
            dangerShadow: 'none',
            defaultColor: '#D4D4D4',
            defaultBg: '#1A1A1A',
            defaultBorderColor: '#333333',
            defaultHoverBg: '#261042',
            defaultHoverColor: '#8B46F2',
            defaultHoverBorderColor: '#8B46F2',
            fontWeight: 500,
          },
          Card: { colorBgContainer: '#242424', headerBg: '#242424' },
          Input: { activeBorderColor: '#8B46F2', hoverBorderColor: '#8B46F2', activeShadow: '0 0 0 2px #261042' },
          Select: { optionSelectedBg: '#261042', optionSelectedColor: '#8B46F2', activeBorderColor: '#8B46F2', hoverBorderColor: '#8B46F2' },
          Segmented: { trackBg: '#0F0F0F', itemSelectedBg: '#261042', itemSelectedColor: '#8B46F2', itemHoverColor: '#8B46F2' },
          Tabs: { itemColor: '#D4D4D4', itemSelectedColor: '#8B46F2', itemHoverColor: '#A366F5', inkBarColor: '#8B46F2' },
          Modal: { contentBg: '#242424', headerBg: '#242424', titleColor: '#F9F9F9' },
          Drawer: { colorBgElevated: '#242424' },
        },
      }}
    >
      <App />
    </ConfigProvider>
  </StrictMode>,
)
