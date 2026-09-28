import { useEffect, useRef, useState } from 'react'
import { Button } from 'antd'
import { CheckOutlined, CopyOutlined, DownloadOutlined } from '@ant-design/icons'
import type { buildWatchlistReview } from '../lib/watchlistReview'
import { downloadWatchlistReview } from '../lib/watchlistShare'

export function WatchlistReviewActions({ buildReview }: { buildReview: (withChart: boolean) => ReturnType<typeof buildWatchlistReview> }) {
  const [copying, setCopying] = useState(false)
  const [copied, setCopied] = useState(false)
  const [notice, setNotice] = useState('')
  const [fallback, setFallback] = useState('')
  const [download, setDownload] = useState<{ url: string; filename: string } | null>(null)
  const fallbackRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => () => { if (download) URL.revokeObjectURL(download.url) }, [download])
  useEffect(() => {
    if (fallback) {
      fallbackRef.current?.focus()
      fallbackRef.current?.select()
    }
  }, [fallback])

  const copySetup = async () => {
    setCopying(true)
    setCopied(false)
    let brief = ''
    try {
      brief = buildReview(false).text
      await navigator.clipboard.writeText(brief)
      setCopied(true)
      setFallback('')
      setNotice('Setup brief copied. Paste it into your agent chat.')
    } catch {
      setFallback(brief)
      setNotice(brief ? 'Clipboard unavailable. Copy the selected brief below, or save the HTML report.' : 'Could not prepare this setup. Try opening the card again.')
    } finally {
      setCopying(false)
    }
  }

  const saveHtml = () => {
    try {
      const report = buildReview(true)
      const url = downloadWatchlistReview(report.html, report.filename)
      setDownload({ url, filename: report.filename })
      setNotice('HTML download started. Attach the file to share the chart and captured data.')
    } catch {
      setNotice('Could not save the report. Try Copy setup to share the evidence.')
    }
  }

  return <section className="watch-detail__share" aria-label="Share setup for review">
    <div className="watch-detail__share-row">
      <div><strong>Share for review</strong><p>Copy the brief for a chat. Save HTML for the chart and full data.</p></div>
      <div className="watch-detail__share-actions">
        <Button className="watch-detail__copy" icon={copied ? <CheckOutlined /> : <CopyOutlined />} loading={copying} onClick={copySetup}>Copy setup</Button>
        <Button icon={<DownloadOutlined />} onClick={saveHtml}>Save HTML</Button>
      </div>
    </div>
    <div className="watch-detail__share-notice" role="status" aria-live="polite">{notice}</div>
    {download && <a className="watch-detail__download-link" href={download.url} download={download.filename}>Download report</a>}
    {fallback && <label className="watch-detail__copy-fallback">Setup brief · select all and copy<textarea ref={fallbackRef} readOnly value={fallback} rows={7} aria-label="Setup brief to copy manually" onFocus={(event) => event.currentTarget.select()} /></label>}
  </section>
}
