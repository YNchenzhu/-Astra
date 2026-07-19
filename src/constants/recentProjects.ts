/** localStorage key — mirrored to disk via {@link queueMirrorRendererPrefsToDisk}. */
export const RECENT_PROJECTS_STORAGE_KEY = 'recentProjects' as const

export const RECENT_PROJECTS_MAX_ENTRIES = 5

/** Same-document notification (StorageEvent only fires across tabs/windows). */
export const RECENT_PROJECTS_CHANGED_EVENT = 'astra:recent-projects-changed' as const
