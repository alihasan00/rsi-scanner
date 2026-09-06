import { useState } from 'react'
import { Button, Dropdown } from 'antd'
import { DownOutlined, StarFilled, StarOutlined } from '@ant-design/icons'
import { useShallow } from 'zustand/react/shallow'
import { useScannerStore } from '../store/scannerStore'
import type { Timeframe } from '../types'
import './TimeframePicker.css'

const TIMEFRAMES: Timeframe[] = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '1d', '3d', '1w']

export function TimeframePicker() {
  const { timeframe, starredTimeframes, setTimeframe, toggleStarredTimeframe } = useScannerStore(
    useShallow((state) => ({
      timeframe: state.timeframe,
      starredTimeframes: state.starredTimeframes,
      setTimeframe: state.setTimeframe,
      toggleStarredTimeframe: state.toggleStarredTimeframe,
    })),
  )
  const [menuOpen, setMenuOpen] = useState(false)

  const starredInOrder = TIMEFRAMES.filter((tf) => starredTimeframes.includes(tf))

  return (
    <div className="timeframe-picker">
      {starredInOrder.map((tf) => (
        <Button
          key={tf}
          size="small"
          type={tf === timeframe ? 'primary' : 'default'}
          className="timeframe-picker__chip"
          onClick={() => setTimeframe(tf)}
        >
          {tf}
        </Button>
      ))}

      <Dropdown
        trigger={['click']}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        popupRender={() => (
          <ul className="timeframe-menu">
            {TIMEFRAMES.map((tf) => {
              const isStarred = starredTimeframes.includes(tf)
              return (
                <li key={tf} className={`timeframe-menu__row ${tf === timeframe ? 'is-active' : ''}`}>
                  <button
                    type="button"
                    className="timeframe-menu__star"
                    aria-label={isStarred ? `Unstar ${tf}` : `Star ${tf}`}
                    aria-pressed={isStarred}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleStarredTimeframe(tf)
                    }}
                  >
                    {isStarred ? <StarFilled /> : <StarOutlined />}
                  </button>
                  <button
                    type="button"
                    className="timeframe-menu__label"
                    onClick={() => {
                      setTimeframe(tf)
                      setMenuOpen(false)
                    }}
                  >
                    {tf}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      >
        <Button size="small" className="timeframe-picker__trigger">
          {timeframe}
          <DownOutlined style={{ fontSize: 10 }} />
        </Button>
      </Dropdown>
    </div>
  )
}
