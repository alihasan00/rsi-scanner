import { Button, Tabs } from 'antd'
import { AppstoreOutlined, SettingOutlined } from '@ant-design/icons'
import { useScannerStore } from '../store/scannerStore'
import './Header.css'

export function Header() {
  const openSettings = useScannerStore((state) => state.openSettings)
  return (
    <header className="app-header">
      <div className="app-header__brand">
        <img className="app-header__mark" src="/favicon.svg" alt="" aria-hidden="true" />
        <span>scanners<span className="app-header__brand-dot">.</span></span>
      </div>
      <nav className="app-header__nav" aria-label="Workspace">
        <Tabs
          activeKey="screener"
          size="small"
          items={[{ key: 'screener', label: 'Screener', icon: <AppstoreOutlined /> }]}
        />
      </nav>
      <div className="app-header__actions">
        <span className="app-header__venue"><span aria-hidden="true">◆</span> Binance Spot <span className="app-header__quote">/ USDT</span></span>
        <Button color="default" variant="solid" className="app-header__settings" icon={<SettingOutlined />} onClick={openSettings} aria-label="Open screener settings">Settings</Button>
      </div>
    </header>
  )
}
