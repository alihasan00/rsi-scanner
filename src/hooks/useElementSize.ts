import { useCallback, useState } from 'react'

interface ElementSize {
  width: number
  height: number
}

/**
 * Tracks an element's content-box size via a callback ref (not useRef +
 * useEffect([])) so it re-attaches correctly when the node mounts later than
 * the owning component — e.g. content inside an antd Modal with
 * destroyOnHidden, which only exists in the DOM while the modal is open.
 */
export function useElementSize<T extends HTMLElement>(): { ref: (node: T | null) => void } & ElementSize {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 })

  const ref = useCallback((node: T | null) => {
    if (!node) return

    const updateSize = (width: number, height: number): void => {
      setSize((current) => (
        current.width === width && current.height === height
          ? current
          : { width, height }
      ))
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      updateSize(width, height)
    })
    observer.observe(node)
    updateSize(node.clientWidth, node.clientHeight)

    return () => observer.disconnect()
  }, [])

  return { ref, ...size }
}
