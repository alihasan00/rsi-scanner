import { Button, Tabs } from 'antd'
import { AppstoreOutlined, BankOutlined, SettingOutlined } from '@ant-design/icons'
import { useScannerStore } from '../store/scannerStore'
import { MARKETS } from '../lib/markets'
import './Header.css'

export function Header() {
  const openSettings = useScannerStore((state) => state.openSettings)
  const market = useScannerStore((state) => state.market)
  const setMarket = useScannerStore((state) => state.setMarket)
  return (
    <header className="app-header">
      <div className="app-header__brand">
        <img className="app-header__mark" src="/favicon.svg" alt="" aria-hidden="true" />
        <span>scanners<span className="app-header__brand-dot">.</span></span>
      </div>
      <nav className="app-header__nav" aria-label="Screener market">
        <Tabs
          activeKey={market}
          onChange={(key) => { if (key === 'spot' || key === 'tradfi') setMarket(key) }}
          size="small"
          items={[
            { key: 'spot', label: 'Crypto', icon: <AppstoreOutlined /> },
            { key: 'tradfi', label: 'TradFi', icon: <BankOutlined /> },
          ]}
        />
      </nav>
      <div className="app-header__actions">
        <span className="app-header__venue"><span aria-hidden="true">◆</span> {MARKETS[market].venue} <span className="app-header__quote">/ USDT</span></span>
        <Button color="default" variant="solid" className="app-header__settings" icon={<SettingOutlined />} onClick={openSettings} aria-label="Open screener settings">Settings</Button>
      </div>
    </header>
  )
}
