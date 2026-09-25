import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { Alert, Button, Drawer, Empty, Input, Modal, Select, Tooltip } from 'antd'
import { ArrowRightOutlined, ClusterOutlined, InfoCircleOutlined, SearchOutlined, StarFilled, StarOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { COIN_FAMILIES, FAMILY_SYMBOLS } from '../lib/coinFamilies'
import type { CoinFamily } from '../lib/coinFamilies'
import { computeFamilyRows, getFamilyBestMovers } from '../lib/familyMarketData'
import type { FamilyMemberRow } from '../lib/familyMarketData'
import { useFamilyMarketData } from '../hooks/useFamilyMarketData'
import { formatQuotePrice } from '../lib/priceFormatting'
import { useScannerStore } from '../store/scannerStore'
import './CoinFamilies.css'

type Summary = ReturnType<typeof computeFamilyRows>
type FamilyFilter = 'all' | CoinFamily['kind']
type FamilySort = 'default' | 'change' | 'gaps'

const KIND_LABELS: Record<CoinFamily['kind'], string> = {
  ecosystem: 'Ecosystem', sector: 'Shared theme', meme: 'Meme coins', other: 'Unclassified',
}
const FILTERS: { value: FamilyFilter; label: string }[] = [
  { value: 'all', label: 'All families' },
  { value: 'ecosystem', label: 'Ecosystems' },
  { value: 'sector', label: 'Sectors' },
  { value: 'meme', label: 'Memes' },
]

function ticker(symbol: string) { return symbol.replace(/USDT$/, '') }
function percent(value: number | null) {
  if (value === null) return '—'
  const rounded = Math.abs(value) < 0.005 ? 0 : value
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(2)}%`
}
function tone(value: number | null) { return value === null || value === 0 ? '' : value > 0 ? 'is-positive' : 'is-negative' }
function volume(value: number) {
  return `$${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)}`
}
function familyStyle(family: CoinFamily): CSSProperties { return { '--family-color': family.color } as CSSProperties }
function freshChange(member: FamilyMemberRow | null | undefined) {
  return member?.quote && !member.isStale && member.quote.quoteVolume > 0 ? member.quote.changePercent : null
}

function FamilyMark({ family }: { family: CoinFamily }) {
  const marks: Record<string, string> = { ETH: 'Ξ', SOL: '◎', BTC: '₿', XRP: 'X', BNB: 'B', ATOM: '✧', DOGE: 'Ð' }
  const anchor = family.anchorSymbol ? ticker(family.anchorSymbol) : ''
  return <span className="families__mark" style={familyStyle(family)} aria-hidden="true">
    {family.kind === 'meme' ? '✳' : family.kind === 'ecosystem' || anchor === 'XRP' ? marks[anchor] ?? anchor.slice(0, 2) : <ClusterOutlined />}
  </span>
}

function FamilyCard({ summary, onOpen }: { summary: Summary; onOpen: () => void }) {
  const { family, leader, averageChange, members, availableCount, totalCount, positiveCount, gapWatchCount } = summary
  const comparable = family.kind !== 'other'
  const fresh = members.filter((member) => freshChange(member) !== null)
  const trailing = fresh.length > 1 ? [...fresh].sort((a, b) => a.quote!.changePercent - b.quote!.changePercent || a.symbol.localeCompare(b.symbol))[0] : null
  const leaderChange = freshChange(leader)
  return (
    <button className={`family-card${gapWatchCount ? ' has-gaps' : ''}`} style={familyStyle(family)} onClick={onOpen} aria-label={`Explore ${family.name}`}>
      <span className="family-card__heading">
        <FamilyMark family={family} />
        <span className="family-card__title"><strong>{family.name}</strong><span>{KIND_LABELS[family.kind]} <i>·</i> {totalCount} coins</span></span>
        <ArrowRightOutlined className="family-card__arrow" />
      </span>
      <span className="family-card__performance">
        <span><strong className={tone(comparable ? averageChange : null)}>{comparable ? percent(averageChange) : totalCount}</strong><span>{comparable ? 'Average · 24h' : 'Assets to explore'}</span></span>
        <span className="family-card__breadth">
          <span className="family-card__heat" aria-hidden="true">{members.map((member) => <i key={member.symbol} className={tone(freshChange(member))} />)}</span>
          <span>{availableCount ? `${positiveCount} of ${availableCount} advancing` : 'Awaiting market data'}</span>
        </span>
      </span>
      {comparable ? <span className="family-card__movers">
        <span><span>{leaderChange !== null && leaderChange > 0 ? 'Leading' : 'Top performer'}</span><b>{leader ? ticker(leader.symbol) : '—'}</b><strong className={tone(leaderChange)}>{percent(leaderChange)}</strong></span>
        <span><span>Trailing</span><b>{trailing ? ticker(trailing.symbol) : '—'}</b><strong className={tone(freshChange(trailing))}>{percent(freshChange(trailing))}</strong></span>
      </span> : <span className="family-card__other">These coins have no curated family yet. Browse them without an assumed link.</span>}
      <span className="family-card__footer">
        <span className={gapWatchCount ? 'family-card__gap-count' : ''}>{gapWatchCount ? <><ThunderboltOutlined /> {gapWatchCount} {gapWatchCount === 1 ? 'price gap' : 'price gaps'}</> : comparable ? 'No qualifying gaps' : 'No relationship assumed'}</span>
        <span>{availableCount}/{totalCount} priced</span>
      </span>
    </button>
  )
}

function FamilyDetails({ summary, onClose }: { summary: Summary | null; onClose: () => void }) {
  const [order, setOrder] = useState<'change' | 'gap' | 'name'>('change')
  const starred = useScannerStore((state) => state.starredSymbols)
  const toggleStarred = useScannerStore((state) => state.toggleStarredSymbol)
  const selectSymbol = useScannerStore((state) => state.selectSymbol)
  const openChart = (symbol: string) => { onClose(); selectSymbol(symbol) }
  const rows = useMemo(() => [...(summary?.members ?? [])].sort((a, b) => {
    if (order === 'name') return a.symbol.localeCompare(b.symbol)
    const aValue = order === 'gap' ? a.leaderGap : freshChange(a)
    const bValue = order === 'gap' ? b.leaderGap : freshChange(b)
    return (bValue ?? -Infinity) - (aValue ?? -Infinity) || a.symbol.localeCompare(b.symbol)
  }), [summary, order])
  const family = summary?.family
  const comparable = family?.kind !== 'other'
  return <Drawer open={!!summary} onClose={onClose} size={680} className="family-detail" title="Inside the family" destroyOnHidden>
    {summary && family && <>
      <div className="family-detail__heading" style={familyStyle(family)}><FamilyMark family={family} /><div><span className="families__eyebrow">{KIND_LABELS[family.kind]}</span><h2>{family.name}</h2></div></div>
      <p className="family-detail__description">{family.description}</p>
      <div className="family-detail__stats">
        <div><span>Average · 24h</span><strong className={tone(comparable ? summary.averageChange : null)}>{percent(comparable ? summary.averageChange : null)}</strong></div>
        <div><span>Advancing</span><strong>{summary.positiveCount}<small> / {summary.availableCount}</small></strong></div>
        <div><span>Volume · 24h</span><strong>{summary.availableCount ? volume(summary.totalQuoteVolume) : '—'}</strong></div>
      </div>
      {comparable && <div className="family-detail__reference">
        <span>{family.kind === 'ecosystem' ? 'Ecosystem anchor' : 'Theme reference'} <b>{family.anchorSymbol ? ticker(family.anchorSymbol) : '—'}</b> <strong className={tone(freshChange(summary.anchor))}>{percent(freshChange(summary.anchor))}</strong></span>
        <span>24h leader <b>{summary.leader ? ticker(summary.leader.symbol) : '—'}</b> <strong className={tone(freshChange(summary.leader))}>{percent(freshChange(summary.leader))}</strong></span>
      </div>}
      <div className="family-detail__table-heading"><h3>Family members <span>{summary.totalCount}</span></h3><Select aria-label="Sort family members" value={order} onChange={setOrder} options={[
        { value: 'change', label: 'Strongest first' }, ...(comparable ? [{ value: 'gap', label: 'Largest gap' }] : []), { value: 'name', label: 'Name: A to Z' },
      ]} /></div>
      <div className="family-detail__table-scroll"><table className="family-detail__table">
        <thead><tr><th scope="col">Coin / connection</th><th scope="col">Price / 24h volume</th><th scope="col">24h</th>{comparable && <th scope="col"><Tooltip title="Leader’s 24h percentage change minus this coin’s change, in percentage points."><span>Gap to leader <InfoCircleOutlined /></span></Tooltip></th>}<th scope="col"><span className="families__sr-only">Favorite</span></th></tr></thead>
        <tbody>{rows.map((member) => <tr key={member.symbol} className={member.isStale ? 'is-stale' : ''}>
          <td><button className="family-detail__coin" onClick={() => openChart(member.symbol)} aria-label={`Open ${ticker(member.symbol)} chart`}><strong>{ticker(member.symbol)} <ArrowRightOutlined /></strong><span>{member.relationship}</span></button></td>
          <td><span className="family-detail__price">{member.quote ? `$${formatQuotePrice(member.quote.price)}` : '—'}</span><span className="family-detail__secondary">{member.quote ? volume(member.quote.quoteVolume) : 'Unavailable'}</span></td>
          <td><strong className={tone(freshChange(member))}>{percent(freshChange(member))}</strong>{member.quote && (member.isStale || member.quote.quoteVolume === 0) && <span className="family-detail__secondary">{member.isStale ? 'Delayed' : 'No trades'}</span>}</td>
          {comparable && <td><span className={member.isGapWatch ? 'family-detail__gap' : 'family-detail__secondary'}>{member.leaderGap === null ? '—' : member.leaderGap === 0 ? member.symbol === summary.leader?.symbol ? 'Leader' : 'Level' : `${member.leaderGap.toFixed(2)} pp`}</span></td>}
          <td><Button type="text" size="small" className={starred.includes(member.symbol) ? 'is-starred' : ''} icon={starred.includes(member.symbol) ? <StarFilled /> : <StarOutlined />} aria-label={`${starred.includes(member.symbol) ? 'Unstar' : 'Star'} ${ticker(member.symbol)}`} aria-pressed={starred.includes(member.symbol)} onClick={() => toggleStarred(member.symbol)} /></td>
        </tr>)}</tbody>
      </table></div>
      <p className="family-detail__hint"><InfoCircleOutlined /> {comparable ? 'Highlighted gaps: leader up at least 3%, with a coin at least 2 percentage points behind. A lagging coin can keep falling; a gap is not a buy signal.' : 'These assets are included for coverage only. Their prices are not compared as a linked group.'}</p>
      <p className="family-detail__coverage">{summary.availableCount} of {summary.totalCount} coins have fresh, traded quotes. Missing, delayed, and zero-volume quotes are excluded from comparisons. Click a coin to open its chart.</p>
    </>}
  </Drawer>
}

export function CoinFamilies() {
  const data = useFamilyMarketData()
  const selectSymbol = useScannerStore((state) => state.selectSymbol)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FamilyFilter>('all')
  const [sort, setSort] = useState<FamilySort>('default')
  const [gapsOnly, setGapsOnly] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [guideOpen, setGuideOpen] = useState(false)
  const summaries = useMemo(() => COIN_FAMILIES.map((family) => computeFamilyRows(family, data.quotes, data.now, { forceStale: data.status === 'error' || data.isStale })), [data.quotes, data.now, data.status, data.isStale])
  const bestMovers = useMemo(() => getFamilyBestMovers(summaries), [summaries])
  const comparable = summaries.filter((summary) => summary.family.kind !== 'other')
  const strongest = [...comparable].filter((summary) => summary.averageChange !== null).sort((a, b) => b.averageChange! - a.averageChange!)[0]
  const watchGroups = comparable.filter((summary) => summary.gapWatchCount > 0)
  const freshQuotes = new Map(summaries.flatMap((summary) => summary.members.filter((member) => freshChange(member) !== null).map((member) => [member.symbol, member.quote!] as const)))
  const advancing = [...freshQuotes.values()].filter((quote) => quote.changePercent > 0).length
  const normalizedQuery = query.trim().toLowerCase()
  const visible = summaries.filter((summary) => {
    if (filter !== 'all' && summary.family.kind !== filter) return false
    if (gapsOnly && !summary.gapWatchCount) return false
    return !normalizedQuery || `${summary.family.name} ${summary.family.description} ${summary.members.map((member) => `${member.symbol} ${member.name} ${member.relationship}`).join(' ')}`.toLowerCase().includes(normalizedQuery)
  }).sort((a, b) => {
    if (a.family.kind === 'other' || b.family.kind === 'other') return Number(a.family.kind === 'other') - Number(b.family.kind === 'other')
    if (sort === 'change') return (b.averageChange ?? -Infinity) - (a.averageChange ?? -Infinity)
    if (sort === 'gaps') return b.gapWatchCount - a.gapWatchCount
    return 0
  })
  const seen = new Set<string>()
  const watch = comparable.flatMap((summary) => summary.members.filter((member) => member.isGapWatch).map((member) => ({ summary, member })))
    .sort((a, b) => b.member.leaderGap! - a.member.leaderGap! || a.member.symbol.localeCompare(b.member.symbol))
    .filter(({ member }) => { if (seen.has(member.symbol)) return false; seen.add(member.symbol); return true }).slice(0, 5)
  const selected = summaries.find((summary) => summary.family.id === selectedId) ?? null
  const loading = data.status === 'loading' && !data.updatedAt
  const delayed = data.isStale || data.status === 'error'
  const statusText = loading ? 'Connecting to Binance' : delayed ? 'Market data delayed' : 'Market data connected'
  const reset = () => { setQuery(''); setFilter('all'); setGapsOnly(false); setSort('default') }

  return <section className="families" aria-label="Coin families">
    <div className="families__content">
      <header className="families__hero">
        <div><span className="families__eyebrow"><ClusterOutlined /> FOLLOW THE CONNECTIONS</span><h1>Coin families<span>.</span></h1><p>One coin moves. See what’s happening around it.</p></div>
        <div className="families__hero-actions"><span className="families__window">Rolling 24h <span>·</span> USDT</span><Button icon={<InfoCircleOutlined />} onClick={() => setGuideOpen(true)}>How it works</Button></div>
      </header>

      <section className="families__best-movers" aria-labelledby="best-movers-heading" aria-busy={loading}>
        <div className="families__best-heading"><h2 id="best-movers-heading"><ThunderboltOutlined /> Best movers <span>24H</span></h2><p>Top 5 gainers across all {FAMILY_SYMBOLS.length} coins</p></div>
        {bestMovers.length ? <ol className="families__best-list">{bestMovers.map(({ quote, families }, index) => {
          const primaryFamily = families[0]
          return <li key={quote.symbol} className="families__best-card" style={familyStyle(primaryFamily)}>
            <button className="families__best-coin" aria-label={`Open ${ticker(quote.symbol)} chart from best movers`} onClick={() => selectSymbol(quote.symbol)}>
              <span className="families__best-rank">{String(index + 1).padStart(2, '0')} <ArrowRightOutlined /></span>
              <span className="families__best-return"><strong>{ticker(quote.symbol)}</strong><b className="is-positive">{percent(quote.changePercent)}</b></span>
              <span className="families__best-price">${formatQuotePrice(quote.price)}</span>
            </button>
            <button className="families__best-family" onClick={() => setSelectedId(primaryFamily.id)} aria-label={`Explore ${primaryFamily.name} for ${ticker(quote.symbol)}`} title={families.map((family) => family.name).join(' · ')}>
              <span className="families__best-dot" /><span>{primaryFamily.name}</span>{families.length > 1 && <small>+{families.length - 1}</small>}<ArrowRightOutlined />
            </button>
          </li>
        })}</ol> : <div className="families__best-empty" role="status"><ThunderboltOutlined /><span>{loading ? 'Finding today’s best movers…' : delayed ? 'Best movers will return when fresh prices are available.' : 'No coins are up over the last 24 hours.'}</span></div>}
      </section>

      <div className="families__overview">
        <button className="families__metric families__metric--strongest" onClick={() => strongest && setSelectedId(strongest.family.id)} disabled={!strongest}>
          <span className="families__metric-label"><span className="families__metric-icon"><ClusterOutlined /></span>Strongest family <ArrowRightOutlined /></span>
          <span className="families__metric-value">{strongest?.family.name ?? '—'}<strong className={tone(strongest?.averageChange ?? null)}>{percent(strongest?.averageChange ?? null)}</strong></span>
          <span className="families__metric-note">Equal-weight average · rolling 24h</span>
        </button>
        <div className="families__metric">
          <span className="families__metric-label"><span className="families__metric-icon families__metric-icon--green">↗</span>Coins advancing</span>
          <span className="families__metric-value">{freshQuotes.size ? advancing : '—'}<small> / {freshQuotes.size || '—'} priced coins</small></span>
          <span className="families__metric-note">{FAMILY_SYMBOLS.length} unique coins across {comparable.length} families</span>
        </div>
        <button className={`families__metric families__metric--watch${gapsOnly ? ' is-active' : ''}`} onClick={() => setGapsOnly(!gapsOnly)} aria-pressed={gapsOnly}>
          <span className="families__metric-label"><span className="families__metric-icon families__metric-icon--amber"><ThunderboltOutlined /></span>Families with price gaps <ArrowRightOutlined /></span>
          <span className="families__metric-value">{loading ? '—' : watchGroups.length}<small> to explore</small></span>
          <span className="families__metric-note">Positive leader · other coins trailing</span>
        </button>
      </div>

      {data.error && <Alert className="families__alert" type="warning" showIcon title="Unable to refresh market prices" description={`${data.error} Last quotes, if available, remain visible in the details. Gap highlights resume when fresh data returns.`} action={<Button size="small" onClick={data.retry}>Retry</Button>} />}

      <div className="families__toolbar">
        <div className="families__filters" role="group" aria-label="Filter families">{FILTERS.map((item) => <button key={item.value} className={filter === item.value ? 'is-active' : ''} aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}</button>)}</div>
        <Input className="families__search" value={query} onChange={(event) => setQuery(event.target.value)} prefix={<SearchOutlined />} allowClear placeholder="Find a family or coin…" aria-label="Search coin families" />
      </div>

      <div className="families__workspace">
        <div className="families__explorer">
          <div className="families__section-heading"><h2>Explore families <span>{visible.length}</span></h2><Select<FamilySort> aria-label="Sort families" value={sort} onChange={setSort} variant="borderless" options={[
            { value: 'default', label: 'Family order' }, { value: 'change', label: 'Strongest first' }, { value: 'gaps', label: 'Most price gaps' },
          ]} /></div>
          {(gapsOnly || query) && <div className="families__filter-summary"><span>{gapsOnly ? 'Families with qualifying price gaps' : `Families matching “${query.trim()}”`}</span><Button type="link" size="small" onClick={reset}>Clear filters</Button></div>}
          {visible.length ? <div className={`families__grid${loading ? ' is-loading' : ''}`} aria-busy={loading}>{visible.map((summary) => <FamilyCard key={summary.family.id} summary={summary} onOpen={() => setSelectedId(summary.family.id)} />)}</div>
            : <div className="families__empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<><h3>{gapsOnly ? 'No families with qualifying gaps' : 'No matching families'}</h3><p>{gapsOnly ? 'A fresh leader needs to be up 3% with another coin at least 2 percentage points behind.' : 'Try a coin symbol, ecosystem, or theme such as XRP, gaming, or memes.'}</p></>}><Button onClick={reset}>Show all families</Button></Empty></div>}
        </div>

        <aside className="families__sidebar" aria-label="Price gap watch">
          <div className="families__watch">
            <div className="families__watch-heading"><span><ThunderboltOutlined /> Gap watch</span><span className="families__badge">24H</span></div>
            <p>A moving leader. A slower family member. A closer look at the gap.</p>
            <div className="families__watch-rule"><span>Leader <b>≥ +3%</b></span><span>Gap <b>≥ 2 pp</b></span></div>
            {watch.length ? <div className="families__watch-list">{watch.map(({ summary, member }) => <button key={member.symbol} className="families__watch-item" onClick={() => setSelectedId(summary.family.id)}>
              <span className="families__watch-family"><span style={{ background: summary.family.color }} />{summary.family.name}<ArrowRightOutlined /></span>
              <span className="families__watch-comparison"><span><b>{ticker(summary.leader!.symbol)}</b><strong className="is-positive">{percent(freshChange(summary.leader))}</strong></span><span className="families__watch-arrow">→</span><span><b>{ticker(member.symbol)}</b><strong className={tone(freshChange(member))}>{percent(freshChange(member))}</strong></span></span>
              <span className="families__watch-gap">{member.leaderGap!.toFixed(2)} pp behind <span>Explore family</span></span>
            </button>)}</div> : <div className="families__watch-empty"><ClusterOutlined /><strong>{loading ? 'Finding the connections' : delayed ? 'Waiting for fresh prices' : 'No qualifying gaps right now'}</strong><span>{loading ? 'Comparing the latest 24h moves.' : delayed ? 'Comparisons resume after the next successful refresh.' : 'Watch updates automatically as the market moves.'}</span></div>}
            <p className="families__watch-note">Price gaps are research leads, not buy signals. A lagging coin may never catch up.</p>
          </div>
          <div className="families__connection-note"><span className="families__connection-icon"><ClusterOutlined /></span><h3>Connected, in different ways.</h3><p><b>Ecosystems</b> share a network. <b>Sectors</b> share a use case. <b>Memes</b> share a narrative. A coin can belong to more than one family.</p><button onClick={() => setGuideOpen(true)}>Understand the groups <ArrowRightOutlined /></button></div>
        </aside>
      </div>

      <footer className="families__footer"><span role="status"><i className={delayed ? 'is-delayed' : loading ? 'is-loading' : ''} />{statusText}</span><span>{freshQuotes.size}/{FAMILY_SYMBOLS.length} quotes <span>·</span> Refreshes every 30s{data.updatedAt && <> <span>·</span> Updated {new Date(data.updatedAt).toLocaleTimeString('en-GB', { timeZone: 'UTC' })} UTC</>}</span><span>Curated groups · Binance Spot</span></footer>
    </div>
    <FamilyDetails key={selectedId ?? 'closed'} summary={selected} onClose={() => setSelectedId(null)} />
    <Modal open={guideOpen} onCancel={() => setGuideOpen(false)} title="Reading coin families" footer={<Button type="primary" onClick={() => setGuideOpen(false)}>Got it</Button>} className="families__guide">
      <p>Start with a family to see its strongest mover and the coins that are moving more slowly. Open a family to compare every member, inspect its connection, star a coin, or open its chart.</p>
      <h3>What makes a family?</h3><p>These are curated ecosystem and theme groupings, not measured correlations. XRP and other payment coins share a use case; they are not all built on the XRP Ledger. Multi-chain projects can appear in several families. Unclassified coins remain available under Other assets.</p>
      <h3>What do the numbers mean?</h3><p>All returns use Binance’s rolling 24-hour ticker. A family average gives each coin with a fresh, traded quote equal weight. The leader has the highest return in that family; it can differ from the ecosystem anchor. Volume is traded USDT, not market capitalization. Missing, delayed, and zero-volume quotes are excluded.</p>
      <h3>When does a gap appear?</h3><p>The leader must be up at least 3%, and a member must trail it by at least 2 percentage points. For example, a leader at +7% and a member at +2% have a 5 pp gap. Gap watch lists up to five distinct coins with the largest qualifying gaps across curated families.</p>
      <p>These thresholds help organize research. They do not establish that one coin will follow another, or that buying a lagging coin is profitable. Check the chart, liquidity, and the reason for the move.</p>
    </Modal>
  </section>
}
