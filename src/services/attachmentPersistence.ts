/**
 * Attachment persistence helpers.
 *
 * Problem: saving a conversation re-emits the full `ChatMessage.attachments`
 * array, which for a PDF or scanned-document attachment means tens of MB of
 * base64 landing in the conversation JSON — on every autosave, forever.
 *
 * Fix:
 *  - On save, call {@link dehydrateMessages} to replace heavy `base64` strings
 *    with a compact sentinel. The source of truth lives in the main-process
 *    `attachment-cache/` keyed by sha256 + kind, already written during ingest.
 *  - On load, call {@link hydrateMessages} which re-fetches the full payload
 *    from the cache via IPC. Cache misses are not fatal — we leave a
 *    `status:'error'` stub so the model & UI still know an attachment existed.
 *
 * Guarantees:
 *  - Dehydrate is purely synchronous, non-throwing — conversations save even
 *    when the cache IPC is unavailable.
 *  - Hydrate is best-effort per attachment; one failure never rejects the
 *    whole conversation load.
 */

import type { Attachment, ChatMessage, ContentBlock } from '../types/tool'

/** Sentinel marking a base64 field that needs cache rehydration on load. */
const DEHYDRATED = '__astra:cache__'

/** Minimum base64 size worth replacing (saves ~O(1KB) per dehydration). */
const MIN_BASE64_BYTES_FOR_POINTER = 4 * 1024

/**
 * Extended block shape used after dehydration. Normal in-memory blocks have
 * `type:'image'` with just {base64, mediaType}; persisted form may also carry
 * `sha256` and a `__dehydrated` flag once staged into the main-process cache.
 */
type PersistedImageBlock = Extract<ContentBlock, { type: 'image' }> & {
  sha256?: string
  __dehydrated?: boolean
}

export function dehydrateMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    const next = { ...m }
    if (m.attachments && m.attachments.length > 0) {
      next.attachments = m.attachments.map(dehydrateAttachment)
    }
    if (m.blocks && m.blocks.length > 0) {
      next.blocks = m.blocks.map(dehydrateBlock)
    }
    return next
  })
}

function dehydrateBlock(b: ContentBlock): ContentBlock {
  if (b.type !== 'image') return b
  const ib = b as PersistedImageBlock
  if (!ib.base64 || ib.base64 === DEHYDRATED || ib.base64.length < MIN_BASE64_BYTES_FOR_POINTER) {
    return b
  }
  // If main already staged this image (via fire-and-forget cacheStageImage),
  // swap to pointer form. If not, leave the block inline so playback remains
  // correct even if cache-staging hasn't completed.
  if (!ib.sha256) return b
  return {
    ...ib,
    base64: DEHYDRATED,
    __dehydrated: true,
  } as ContentBlock
}

function dehydrateAttachment(a: Attachment): Attachment {
  if (a.type === 'image') {
    if (!a.sha256 || !a.base64 || a.base64.length < MIN_BASE64_BYTES_FOR_POINTER) return a
    return { ...a, base64: DEHYDRATED }
  }
  if (a.type === 'file') {
    let out: typeof a = a
    if (a.pdf?.base64 && a.pdf.base64.length >= MIN_BASE64_BYTES_FOR_POINTER && a.sha256) {
      out = { ...out, pdf: { ...a.pdf, base64: DEHYDRATED } }
    }
    if (a.pageImages && a.pageImages.length > 0 && a.sha256) {
      const stripped = a.pageImages.map((pi) =>
        pi.base64.length >= MIN_BASE64_BYTES_FOR_POINTER
          ? { ...pi, base64: DEHYDRATED as typeof pi.base64 }
          : pi,
      )
      out = { ...out, pageImages: stripped }
    }
    return out
  }
  return a
}

/** True if *any* heavy base64 field on the attachment is a dehydration sentinel. */
function isDehydrated(a: Attachment): boolean {
  if (a.type === 'image') return a.base64 === DEHYDRATED
  if (a.type === 'file') {
    if (a.pdf?.base64 === DEHYDRATED) return true
    if (a.pageImages?.some((p) => p.base64 === DEHYDRATED)) return true
  }
  return false
}

export async function hydrateMessages(messages: ChatMessage[]): Promise<ChatMessage[]> {
  const api = typeof window !== 'undefined' ? window.electronAPI?.attachments : undefined
  const cacheGet = api?.cacheGet
  if (!cacheGet) return messages // Browser/test mode — cannot rehydrate.

  return Promise.all(
    messages.map(async (m) => {
      const needs = (m.attachments?.some(isDehydrated) ?? false) ||
        (m.blocks?.some(isDehydratedBlock) ?? false)
      if (!needs) return m
      const next = { ...m }
      if (m.attachments && m.attachments.length > 0) {
        next.attachments = await Promise.all(
          m.attachments.map((a) => hydrateAttachment(a, cacheGet)),
        )
      }
      if (m.blocks && m.blocks.length > 0) {
        next.blocks = await Promise.all(
          m.blocks.map((b) => hydrateBlock(b, cacheGet)),
        )
      }
      return next
    }),
  )
}

function isDehydratedBlock(b: ContentBlock): boolean {
  if (b.type !== 'image') return false
  const ib = b as PersistedImageBlock
  return !!ib.__dehydrated || ib.base64 === DEHYDRATED
}

async function hydrateBlock(
  b: ContentBlock,
  cacheGet: NonNullable<NonNullable<Window['electronAPI']['attachments']>['cacheGet']>,
): Promise<ContentBlock> {
  if (!isDehydratedBlock(b)) return b
  const ib = b as PersistedImageBlock
  const sha = ib.sha256
  if (!sha) return b
  try {
    const cached = await cacheGet({ sha256: sha, kind: 'image' })
    if (cached && cached.type === 'image') {
      return { ...ib, base64: cached.base64, mediaType: cached.mediaType }
    }
  } catch {
    // Fall through — leave dehydrated block; renderer will show a placeholder.
  }
  return b
}

/**
 * Fire-and-forget: stage every big `blocks[].image` base64 into the
 * attachment cache so subsequent saves can dehydrate them. Called from
 * `saveCurrentConversation` before `cleanMessagesForPersist` runs.
 */
export async function preStageBlockImages(messages: ChatMessage[]): Promise<ChatMessage[]> {
  const api = typeof window !== 'undefined' ? window.electronAPI?.attachments : undefined
  const stage = api?.cacheStageImage
  if (!stage) return messages

  return Promise.all(
    messages.map(async (m) => {
      if (!m.blocks || m.blocks.length === 0) return m
      const blocks = await Promise.all(
        m.blocks.map(async (b) => {
          if (b.type !== 'image') return b
          const ib = b as PersistedImageBlock
          if (ib.sha256 || !ib.base64 || ib.base64.length < MIN_BASE64_BYTES_FOR_POINTER) return b
          try {
            const r = await stage({ base64: ib.base64, mediaType: ib.mediaType })
            if (r && r.ok) {
              return { ...ib, sha256: r.sha256 } as ContentBlock
            }
          } catch { /* noop */ }
          return b
        }),
      )
      return { ...m, blocks }
    }),
  )
}

async function hydrateAttachment(
  a: Attachment,
  cacheGet: NonNullable<NonNullable<Window['electronAPI']['attachments']>['cacheGet']>,
): Promise<Attachment> {
  if (!isDehydrated(a)) return a
  const sha = a.sha256
  if (!sha) {
    // No pointer — make it degrade gracefully in UI + prompt.
    if (a.type === 'file') {
      return { ...a, status: 'error' as const, error: 'attachment payload missing (no cache key)' }
    }
    return a
  }
  const kindHint = a.type === 'image' ? 'image' : (a.kind || 'unknown')
  try {
    const cached = await cacheGet({ sha256: sha, kind: kindHint })
    if (!cached) {
      if (a.type === 'file') {
        return { ...a, status: 'error' as const, error: 'attachment removed from cache (too old)' }
      }
      return a
    }

    // Merge cache payload (authoritative bytes) back into the stored shell.
    if (a.type === 'image' && cached.type === 'image') {
      return { ...a, base64: cached.base64, mediaType: cached.mediaType }
    }
    if (a.type === 'file' && cached.type === 'file') {
      const merged: Attachment = { ...a }
      if (cached.pdf?.base64) merged.pdf = { ...(a.pdf || { pageCount: cached.pdf.pageCount }), base64: cached.pdf.base64 }
      if (cached.pageImages) merged.pageImages = cached.pageImages
      // Preserve any locally-computed text that the cache may have stripped.
      if (!merged.text && cached.text) merged.text = cached.text
      return merged
    }
    return a
  } catch {
    if (a.type === 'file') {
      return { ...a, status: 'error' as const, error: 'failed to rehydrate from cache' }
    }
    return a
  }
}
