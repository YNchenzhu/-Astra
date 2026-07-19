/**
 * Local HTTP hook for automation (upstream RemoteTrigger subset — POST only).
 */

import http from 'node:http'
import crypto from 'node:crypto'

let server: http.Server | null = null
let currentSecret = ''
let currentPort = 0

export function getRemoteTriggerStatus(): { running: boolean; port: number; secret: string } {
  return { running: server !== null, port: currentPort, secret: currentSecret }
}

export function startRemoteTriggerServer(): Promise<{ port: number; secret: string }> {
  if (server) {
    return Promise.resolve({ port: currentPort, secret: currentSecret })
  }
  currentSecret = crypto.randomBytes(18).toString('hex')
  server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/hook') {
      res.writeHead(404)
      res.end()
      return
    }
    const h = req.headers['x-trigger-secret']
    if (h !== currentSecret) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    // Cap request body at 64 KiB so a malicious or malformed client
    // cannot drive the main process into an OOM by streaming large
    // payloads. We only need the hook token, which is tiny — anything
    // larger is rejected and the socket torn down.
    const MAX_BODY_BYTES = 64 * 1024
    let received = 0
    let aborted = false
    req.on('data', (chunk: Buffer) => {
      if (aborted) return
      received += chunk.length
      if (received > MAX_BODY_BYTES) {
        aborted = true
        try {
          res.writeHead(413, { 'Content-Type': 'text/plain' })
          res.end('payload too large')
        } catch {
          /* ignore */
        }
        try { req.destroy() } catch { /* ignore */ }
      }
    })
    req.on('end', () => {
      if (aborted) return
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
    })
    // Cap total request duration as a second safety net.
    req.setTimeout(5000, () => {
      if (aborted) return
      aborted = true
      try {
        res.writeHead(408)
        res.end()
      } catch { /* ignore */ }
      try { req.destroy() } catch { /* ignore */ }
    })
  })

  return new Promise((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', () => {
      const a = server!.address()
      currentPort = typeof a === 'object' && a ? a.port : 0
      resolve({ port: currentPort, secret: currentSecret })
    })
  })
}

export async function stopRemoteTriggerServer(): Promise<void> {
  const closingServer = server
  server = null
  currentPort = 0
  currentSecret = ''
  if (!closingServer) return
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve()
    }
    const timeout = setTimeout(finish, 300)
    closingServer.close(finish)
    closingServer.closeAllConnections?.()
  })
}
