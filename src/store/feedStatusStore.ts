import { createSymbolStore } from './dataStore'

export interface FeedStatus {
  state: 'loading' | 'ready' | 'error'
  updatedAt: number | null
  error: string | null
}

const store = createSymbolStore<FeedStatus>({ state: 'loading', updatedAt: null, error: null })

export const getFeedStatus = store.get
export const setFeedStatus = store.set
export const resetFeedStatus = store.reset
export const subscribeFeedStatus = store.subscribe
export const subscribeAllFeedStatuses = store.subscribeAll
export const getFeedStatusVersion = store.getVersion
