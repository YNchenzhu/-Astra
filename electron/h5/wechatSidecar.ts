/**
 * WeChat adapter sidecar manager.
 *
 * Runs the bundled `dist-adapter/wechat-adapter.cjs` (a dependency-free Node
 * build — no Bun required) inside an Electron `utilityProcess`, pointed at the
 * local H5 server. Auto-starts when a WeChat account is bound and the H5 server
 * is running, so the packaged app needs zero manual setup.
 */
import { app, utilityProcess, type UtilityProcess } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { getH5ServerStatus } from './h5Server'
import { loadImConfig } from './imConfig'

let child: UtilityProcess | null = null
let lastError: string | null = null

export interface WechatSidecarStatus {
  running: boolean
  error: string | null
  /** True when the bundled adapter file is present (else run `npm run build:adapter`). */
  bundleAvailable: boolean
}

/** Locate the bundled adapter: packaged → resources/adapter, dev → dist-adapter. */
function adapterEntryPath(): string | null {
  const packaged = path.join(process.resourcesPath || '', 'adapter', 'wechat-adapter.cjs')
  if (fs.existsSync(packaged)) return packaged
  try {
    const dev = path.join(app.getAppPath(), 'dist-adapter', 'wechat-adapter.cjs')
    if (fs.existsSync(dev)) return dev
  } catch {
    /* ignore */
  }
  return null
}

export function getWechatSidecarStatus(): WechatSidecarStatus {
  return { running: child !== null, error: lastError, bundleAvailable: adapterEntryPath() !== null }
}

/** Start the sidecar if WeChat is bound and the H5 server is up. Idempotent. */
export function startWechatSidecar(): WechatSidecarStatus {
  if (child) return getWechatSidecarStatus()
  lastError = null

  const cfg = loadImConfig()
  if (!cfg.wechat.hasBotToken || !cfg.wechat.accountId) {
    lastError = '微信未绑定'
    return getWechatSidecarStatus()
  }
  const server = getH5ServerStatus()
  if (!server.running) {
    lastError = 'H5 服务未运行（请先在「远程访问 (H5)」启用）'
    return getWechatSidecarStatus()
  }
  const entry = adapterEntryPath()
  if (!entry) {
    lastError = '未找到适配器打包文件（请运行 npm run build:adapter）'
    return getWechatSidecarStatus()
  }

  const host = server.host === '0.0.0.0' || server.host === '::' ? '127.0.0.1' : server.host
  const serverUrl = `ws://${host}:${server.port}`
  try {
    child = utilityProcess.fork(entry, [], {
      env: { ...process.env, ADAPTER_SERVER_URL: serverUrl },
      stdio: 'pipe',
    })
    child.stdout?.on('data', (d: Buffer) => console.log('[wechat-adapter]', d.toString().trim()))
    child.stderr?.on('data', (d: Buffer) => console.warn('[wechat-adapter]', d.toString().trim()))
    child.on('exit', (code) => {
      console.log(`[wechatSidecar] exited (code=${code})`)
      child = null
    })
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
    child = null
  }
  return getWechatSidecarStatus()
}

export function stopWechatSidecar(): void {
  if (child) {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
    child = null
  }
}

/** Stop then start — used after binding / config changes so new creds apply. */
export function restartWechatSidecar(): WechatSidecarStatus {
  stopWechatSidecar()
  return startWechatSidecar()
}
