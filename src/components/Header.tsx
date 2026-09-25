import { Button, Tabs } from 'antd'
import { AppstoreOutlined, BankOutlined, ClusterOutlined, SettingOutlined } from '@ant-design/icons'
import { useScannerStore } from '../store/scannerStore'
import { MARKETS } from '../lib/markets'
import './Header.css'

export function Header() {
  const openSettings = useScannerStore((state) => state.openSettings)
  const market = useScannerStore((state) => state.market)
  const appView = useScannerStore((state) => state.appView)
  const setMarket = useScannerStore((state) => state.setMarket)
  const setAppView = useScannerStore((state) => state.setAppView)
  return (
    <header className="app-header">
      <div className="app-header__brand">
        <img className="app-header__mark" src="/favicon.svg" alt="" aria-hidden="true" />
        <span>scanners<span className="app-header__brand-dot">.</span></span>
      </div>
      <nav className="app-header__nav" aria-label="Scanner views">
        <Tabs
          activeKey={appView === 'families' ? 'families' : market}
          onChange={(key) => {
            if (key === 'families') setAppView('families')
            else if (key === 'spot' || key === 'tradfi') setMarket(key)
          }}
          size="small"
          items={[
            { key: 'families', label: 'Coin Families', icon: <ClusterOutlined /> },
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
