/**
 * Plan tab helpers — open the structured plan as a Markdown tab in the
 * editor area instead of cramming it into the inline approval card.
 *
 * Two tab flavours share one slot:
 *   1. Pre-approval preview — an in-memory ("untitled") markdown tab
 *      synthesized from the pending approval envelope. No disk file is
 *      written, so a rejected plan leaves nothing behind.
 *   2. Post-approval real file — the persisted `.cursor/plans/*.plan.md`
 *      opened by absolute path and kept live via `plan:updated` stream
 *      events (see `ensurePlanTabStream`).
 */

import type { PlanApprovalRequestDisplay, PlanTodo, TabInfo, StreamEvent } from '../types'
import { useFileStore } from '../stores/useFileStore'
import { useActivePlanStore } from '../stores/useActivePlan'
import { onStreamEvent } from './electronAPI'
import { readFile } from './fileSystem'

/** Stable path for the single in-memory preview tab. `untitled` prefix keeps
 * it out of the editor autosave path (see EditorArea autosave guard). */
export const PLAN_PREVIEW_PATH = 'untitled-plan-preview'
const PLAN_PREVIEW_NAME = '计划预览.plan.md'

/** A tab is a "plan tab" (preview or persisted) when its name ends `.plan.md`. */
export function isPlanTabName(name: string): boolean {
  return name.toLowerCase().endsWith('.plan.md')
}

/**
 * Strip a leading YAML frontmatter block (`--- … ---`) for the rendered
 * preview only. The persisted plan file keeps its frontmatter (it drives
 * `planRuntime` restore + task seeding); we just don't want the raw YAML
 * shown to the user in the markdown preview pane. Operates on a copy —
 * the editor buffer / disk content is untouched.
 */
export function stripFrontmatter(md: string): string {
  return md.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

function todoLine(t: PlanTodo): string {
  const box = t.status === 'completed' || t.status === 'cancelled' ? '[x]' : '[ ]'
  const suffix =
    t.status === 'in_progress' ? ' ⟳ (进行中)'
      : t.status === 'cancelled' ? ' (已取消)'
        : ''
  return `- ${box} ${t.content}${suffix}`
}

/** Build readable markdown from the approval envelope for the preview tab. */
export function synthesizePlanMarkdown(request: PlanApprovalRequestDisplay): string {
  const parts: string[] = []
  parts.push(`# ${request.name?.trim() || '实施计划'}`)
  if (request.overview?.trim()) {
    parts.push('', request.overview.trim())
  }
  if (request.planMarkdown?.trim()) {
    parts.push('', '## 计划', '', request.planMarkdown.trim())
  }
  if (request.phases && request.phases.length > 0) {
    for (const ph of request.phases) {
      parts.push('', `## ${ph.name} (${ph.todos.length} 项)`, '')
      for (const t of ph.todos) parts.push(todoLine(t))
    }
  } else if (request.todos && request.todos.length > 0) {
    parts.push('', '## 步骤', '')
    for (const t of request.todos) parts.push(todoLine(t))
  }
  parts.push('')
  return parts.join('\n')
}

function upsertTab(tab: TabInfo): void {
  const store = useFileStore.getState()
  const existing = store.tabs.find((t) => t.path === tab.path)
  if (existing) {
    // syncTabContentFromDisk replaces content and clears the dirty flag so
    // the autosave timer never fires for a refreshed plan tab.
    store.syncTabContentFromDisk(existing.id, tab.content)
    store.setActiveTab(existing.id)
    return
  }
  store.openFile(tab)
}

/** Open (or refresh) the in-memory plan preview tab from the pending request. */
export function openPlanPreviewTab(request: PlanApprovalRequestDisplay): void {
  upsertTab({
    id: PLAN_PREVIEW_PATH,
    path: PLAN_PREVIEW_PATH,
    name: PLAN_PREVIEW_NAME,
    language: 'markdown',
    content: synthesizePlanMarkdown(request),
    isModified: false,
  })
}

/** Close the in-memory preview tab if present (e.g. on approval / cancel). */
export function closePlanPreviewTab(): void {
  const store = useFileStore.getState()
  const tab = store.tabs.find((t) => t.path === PLAN_PREVIEW_PATH)
  if (tab) store.closeTab(tab.id)
}

function basename(p: string): string {
  const seg = p.split(/[/\\]/)
  return seg[seg.length - 1] || p
}

/** Open (or refresh) the persisted plan file tab by absolute path. */
function openPlanFileTab(planFilePath: string, content: string): void {
  upsertTab({
    id: `planfile:${planFilePath}`,
    path: planFilePath,
    name: basename(planFilePath),
    language: 'markdown',
    content,
    isModified: false,
  })
}

/**
 * Re-open the active plan file tab. Used by the persistent "查看计划" entry
 * (e.g. the task panel header) after the approval bar is gone. Reads fresh
 * content from disk when possible, falling back to the last cached content.
 */
export async function openActivePlanTab(): Promise<void> {
  const { planFilePath, content } = useActivePlanStore.getState()
  if (!planFilePath) return
  let fresh = content
  try {
    fresh = await readFile(planFilePath)
    useActivePlanStore.getState().updateContent(fresh)
  } catch {
    /* fall back to cached content */
  }
  openPlanFileTab(planFilePath, fresh)
}

let streamInstalled = false
let streamUnsub: (() => void) | null = null

/**
 * Install the once-per-process subscription that turns `plan:active` /
 * `plan:updated` stream events into live tab actions. Mirrors the
 * `ensureTaskListV2Stream` pattern so multiple mounts share one listener.
 */
export function ensurePlanTabStream(): void {
  if (streamInstalled) return
  streamInstalled = true
  try {
    const off = onStreamEvent((event: StreamEvent) => {
      if (event.type === 'plan:active') {
        if (!event.planFilePath) return
        const content = event.planContent ?? ''
        // Remember the active plan so a persistent "查看计划" entry can reopen
        // it after the approval bar disappears.
        useActivePlanStore.getState().setActive(event.planFilePath, content)
        // Approval landed: replace the in-memory preview with the real file.
        closePlanPreviewTab()
        openPlanFileTab(event.planFilePath, content)
        return
      }
      if (event.type === 'plan:updated') {
        if (!event.planFilePath) return
        if (typeof event.planContent === 'string') {
          useActivePlanStore.getState().setActive(event.planFilePath, event.planContent)
        }
        const store = useFileStore.getState()
        const tab = store.tabs.find((t) => t.path === event.planFilePath)
        // Only live-refresh when the tab is open and the user hasn't started
        // editing it (don't clobber unsaved manual edits).
        if (tab && !tab.isModified && typeof event.planContent === 'string') {
          store.syncTabContentFromDisk(tab.id, event.planContent)
        }
      }
    })
    streamUnsub = typeof off === 'function' ? off : null
  } catch {
    streamInstalled = false
    streamUnsub = null
  }
}

/** Test / HMR teardown counterpart of {@link ensurePlanTabStream}. */
export function disposePlanTabStream(): void {
  if (streamUnsub) {
    try { streamUnsub() } catch { /* noop */ }
    streamUnsub = null
  }
  streamInstalled = false
}
