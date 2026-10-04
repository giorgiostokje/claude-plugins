/** The prompt cache lifetimes Claude Code requests. */
export type CacheWarmerTtl = '1h' | '5m'

declare module 'claude-code' {
  interface PluginState {
    'cache-warmer': {
      /** When the main thread last touched the cache (ms since epoch); null while unarmed. */
      lastTouch: number | null
      /** Consecutive warm-ups since the last real request. */
      warmups: number
      /** What those warm-ups cost, in base-input-token equivalents. */
      spent: number
      /** Whether warming is switched on (/keepwarm on|off). */
      isEnabled: boolean
      /** The session's transcript, where each request's cache TTL is recorded. */
      transcriptPath: string | null
      /** The TTL the last cache write actually used, read from the transcript. */
      ttlObserved: CacheWarmerTtl | null
      /** The model that answered the last real request. */
      model: string | null
    }
  }
}
