/** Preserve the visible chart without depending on the app's stylesheet or fonts. */
export function captureWatchlistChart(svg: SVGSVGElement | null): { markup: string; caption: string } | undefined {
  if (!svg) return undefined
  const clone = svg.cloneNode(true) as SVGSVGElement
  const originals = [svg, ...svg.querySelectorAll<SVGElement>('*')]
  const copies = [clone, ...clone.querySelectorAll<SVGElement>('*')]
  const properties = [
    'color', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
    'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset',
    'opacity', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'text-anchor',
    'dominant-baseline', 'paint-order', 'vector-effect',
  ]
  originals.forEach((element, index) => {
    const computed = window.getComputedStyle(element)
    const copy = copies[index]
    copy.removeAttribute('style')
    for (const property of properties) copy.style.setProperty(property, computed.getPropertyValue(property))
    // Use portable system fonts; the report must work without downloading app assets.
    copy.style.fontFamily = computed.fontFamily.includes('Mono') ? 'monospace' : 'sans-serif'
    copy.removeAttribute('tabindex')
    copy.removeAttribute('aria-description')
  })
  clone.querySelectorAll('.watch-setup-chart__crosshair').forEach((node) => node.remove())
  const { width, height } = svg.viewBox.baseVal
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', String(width))
  clone.setAttribute('height', String(height))
  const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  background.setAttribute('width', String(width))
  background.setAttribute('height', String(height))
  background.setAttribute('fill', '#151417')
  clone.insertBefore(background, clone.firstChild)
  return { markup: new XMLSerializer().serializeToString(clone), caption: svg.querySelector('title')?.textContent ?? '' }
}

/** The caller retains the URL for a normal download link and releases it on cleanup. */
export function downloadWatchlistReview(html: string, filename: string): string {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  return url
}
