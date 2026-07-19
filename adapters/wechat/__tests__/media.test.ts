import { afterEach, describe, expect, it } from 'bun:test'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AttachmentStore } from '../../common/attachment/attachment-store.js'
import { collectWechatMediaCandidates, WechatMediaService } from '../media.js'

const originalFetch = globalThis.fetch

function tempStore(): { store: AttachmentStore; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-'))
  return { store: new AttachmentStore({ root }), root }
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

function mockFetchReturning(buf: Buffer, ok = true, status = 200): void {
  globalThis.fetch = (async () => ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERR',
    arrayBuffer: async () => toArrayBuffer(buf),
  })) as unknown as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('collectWechatMediaCandidates', () => {
  it('parses an image item (type 2), converting the hex aeskey to base64', () => {
    const hexKey = '00112233445566778899aabbccddeeff' // 16 bytes
    const candidates = collectWechatMediaCandidates([
      {
        type: 2,
        msg_id: 'm1',
        image_item: {
          url: 'https://cdn.example/full.jpg',
          aeskey: hexKey,
          media: { full_url: 'https://cdn.example/full.jpg', encrypt_query_param: 'q=1', aes_key: 'ignored' },
        },
      } as never,
    ])
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ kind: 'image', mimeType: 'image/jpeg', url: 'https://cdn.example/full.jpg' })
    // aeskey hex → base64 of the raw 16 bytes.
    expect(candidates[0].aesKey).toBe(Buffer.from(hexKey, 'hex').toString('base64'))
    expect(candidates[0].name).toContain('wechat-image-m1')
  })

  it('parses a file item (type 4) and infers the mime from the extension', () => {
    const candidates = collectWechatMediaCandidates([
      {
        type: 4,
        msg_id: 'f1',
        file_item: {
          file_name: 'report.pdf',
          media: { full_url: 'https://cdn.example/report', encrypt_query_param: 'q=2', aes_key: 'KEY' },
        },
      } as never,
    ])
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ kind: 'file', name: 'report.pdf', mimeType: 'application/pdf' })
  })

  it('ignores items without media payloads', () => {
    expect(collectWechatMediaCandidates([{ type: 1, text_item: { text: 'hi' } } as never])).toHaveLength(0)
    expect(collectWechatMediaCandidates(undefined)).toHaveLength(0)
  })
})

describe('WechatMediaService.downloadCandidate', () => {
  it('downloads plain (un-encrypted) bytes and writes them to the store', async () => {
    const { store, root } = tempStore()
    const payload = Buffer.from('plain image bytes')
    mockFetchReturning(payload)

    const result = await new WechatMediaService(store).downloadCandidate(
      { kind: 'image', name: 'pic.jpg', mimeType: 'image/jpeg', url: 'https://cdn/pic.jpg' },
      'sess-1',
    )

    expect(result.kind).toBe('image')
    expect(result.size).toBe(payload.length)
    expect(result.mimeType).toBe('image/jpeg')
    expect(Buffer.compare(result.buffer, payload)).toBe(0)
    // Written to disk under the temp root.
    expect(result.path.startsWith(root)).toBe(true)
    expect(Buffer.compare(fs.readFileSync(result.path), payload)).toBe(0)
  })

  it('AES-128-ECB decrypts encrypted media when an aesKey is present', async () => {
    const { store } = tempStore()
    const key = Buffer.alloc(16, 7) // deterministic 16-byte key
    const plaintext = Buffer.from('the quick brown fox jumps over')
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null)
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    mockFetchReturning(ciphertext)

    const result = await new WechatMediaService(store).downloadCandidate(
      { kind: 'file', name: 'doc.bin', url: 'https://cdn/doc', aesKey: key.toString('base64') },
      'sess-2',
    )

    expect(Buffer.compare(result.buffer, plaintext)).toBe(0)
  })

  it('builds the CDN URL from encryptQueryParam when no direct url is given', async () => {
    const { store } = tempStore()
    const payload = Buffer.from('cdn bytes')
    let requestedUrl = ''
    globalThis.fetch = (async (url: string) => {
      requestedUrl = String(url)
      return { ok: true, status: 200, statusText: 'OK', arrayBuffer: async () => toArrayBuffer(payload) }
    }) as unknown as typeof fetch

    const result = await new WechatMediaService(store).downloadCandidate(
      { kind: 'image', name: 'x.jpg', encryptQueryParam: 'a=b&c=d' },
      'sess-3',
    )
    expect(requestedUrl).toContain('a=b&c=d')
    expect(Buffer.compare(result.buffer, payload)).toBe(0)
  })

  it('throws when the media item has no url and no encryptQueryParam', async () => {
    const { store } = tempStore()
    mockFetchReturning(Buffer.from('unused'))
    await expect(
      new WechatMediaService(store).downloadCandidate({ kind: 'image', name: 'x.jpg' }, 'sess-4'),
    ).rejects.toThrow(/missing a download URL/)
  })

  it('throws on a non-OK download response', async () => {
    const { store } = tempStore()
    mockFetchReturning(Buffer.from('x'), false, 500)
    await expect(
      new WechatMediaService(store).downloadCandidate(
        { kind: 'image', name: 'x.jpg', url: 'https://cdn/x' },
        'sess-5',
      ),
    ).rejects.toThrow(/download failed/)
  })
})
