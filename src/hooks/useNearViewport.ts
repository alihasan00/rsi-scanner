import { useCallback, useState } from 'react'

type VisibilityListener = (isNearViewport: boolean) => void

const listeners = new Map<Element, VisibilityListener>()
let observer: IntersectionObserver | null = null

function getObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          listeners.get(entry.target)?.(entry.isIntersecting)
        }
      },
      { rootMargin: '300px 0px' },
    )
  }
  return observer
}

/**
 * Keeps work active for visible and soon-to-be-visible grid cells. One shared
 * observer is used for the whole grid instead of creating one per card.
 */
export function useNearViewport<T extends Element>(): {
  ref: (node: T | null) => (() => void) | undefined
  isNearViewport: boolean
} {
  // Modern browsers activate only nearby cards after the first observer pass;
  // older/test environments without IntersectionObserver stay fully active.
  const [isNearViewport, setIsNearViewport] = useState(
    () => typeof IntersectionObserver === 'undefined',
  )

  const ref = useCallback((node: T | null) => {
    if (!node) return
    const sharedObserver = getObserver()
    if (!sharedObserver) return

    listeners.set(node, setIsNearViewport)
    sharedObserver.observe(node)

    return () => {
      sharedObserver.unobserve(node)
      listeners.delete(node)
      if (listeners.size === 0) {
        sharedObserver.disconnect()
        if (observer === sharedObserver) observer = null
      }
    }
  }, [])

  return { ref, isNearViewport }
}
