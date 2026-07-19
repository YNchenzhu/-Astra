/** Debounce for coalescing filesystem watcher events before tree refresh / disk→tab sync. */
export const WORKSPACE_FILE_WATCH_DEBOUNCE_MS = 220

/** Monaco: only used when `onDidChangeMarkers` is unavailable (rare). */
export const MONACO_MARKER_POLL_FALLBACK_MS = 3000

/** Delay before first marker sync after a model is created (worker warm-up). */
export const MONACO_NEW_MODEL_MARKER_DELAY_MS = 400

/** Debounce for model content → diagnostics / LSP didChange. */
export const MONACO_MODEL_CONTENT_DEBOUNCE_MS = 500

/** Inline diff: second scroll attempt after layout (see InlineDiffDecorator). */
export const INLINE_DIFF_REVEAL_FALLBACK_MS = 100
