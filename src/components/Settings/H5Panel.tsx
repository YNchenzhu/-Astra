import React, { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Copy, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { H5StatusPayload } from '../../types/electronAPI'
import { ToggleRow, InputField, NumberField } from '../AIChat/settingsControls'
import { useT } from '../../i18n'

/**
 * Build the scannable launch URL embedding both the server URL and the freshly
 * generated token, so a phone scan connects with no manual entry. Returns null
 * when no reachable base URL can be determined (bound to 0.0.0.0 with no LAN
 * address and no public URL → ask the user to set a public URL).
 */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

function buildLaunchUrl(s: H5StatusPayload, token: string, overrideAddress?: string): string | null {
  const port = s.server.port || s.settings.port
  let base = s.settings.publicBaseUrl?.trim() || ''
  if (!base) {
    const host = s.server.host || s.settings.host
    if (host === '0.0.0.0' || host === '::') {
      // Bound to all interfaces — use the chosen / best-detected LAN IP so
      // other devices can reach it (NOT a VPN/virtual adapter address).
      const addr = overrideAddress || s.server.lanAddress
      base = addr ? `http://${addr}:${port}` : ''
    } else if (isLoopbackHost(host)) {
      // Loopback-only: NOT reachable from a phone. Return null so the panel
      // tells the user to switch Host to 0.0.0.0 instead of showing a QR that
      // would fail with a network error.
      base = ''
    } else {
      base = `http://${host}:${port}`
    }
  }
  if (!base) return null
  base = base.replace(/\/$/, '')
  return `${base}/?serverUrl=${encodeURIComponent(base)}&h5Token=${encodeURIComponent(token)}`
}

/**
 * H5 / 远程访问设置面板。
 *
 * 对接主进程 `electron/h5/*`：开关服务、生成一次性 Token、配置允许来源 /
 * 公开地址 / 监听 host:port。Token 原文只在生成时显示一次。
 */
export const H5Panel: React.FC = () => {
  const t = useT().settings.h5
  const [status, setStatus] = useState<H5StatusPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [revealedToken, setRevealedToken] = useState<string | null>(null)
  const [launchUrl, setLaunchUrl] = useState<string | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [selectedAddress, setSelectedAddress] = useState<string>('')
  const [newOrigin, setNewOrigin] = useState('')
  const [localHost, setLocalHost] = useState('')
  const [localPort, setLocalPort] = useState(5174)
  const [localPublicBaseUrl, setLocalPublicBaseUrl] = useState('')
  const [error, setError] = useState<string | null>(null)

  type H5Api = {
    getStatus: () => Promise<H5StatusPayload>
    setConfig: (patch: Record<string, unknown>) => Promise<H5StatusPayload>
    generateToken: () => Promise<{ token: string; preview: string; status: H5StatusPayload }>
    start: () => Promise<H5StatusPayload>
    stop: () => Promise<H5StatusPayload>
  }
  const h5 = (window as unknown as { electronAPI?: { h5?: H5Api } }).electronAPI?.h5

  const applyStatus = useCallback((s: H5StatusPayload) => {
    setStatus(s)
    setLocalHost(s.settings.host)
    setLocalPort(s.settings.port)
    setLocalPublicBaseUrl(s.settings.publicBaseUrl ?? '')
    setError(s.error ?? null)
  }, [])

  useEffect(() => {
    if (!h5) {
      setLoading(false)
      setError(t.apiUnavailable)
      return
    }
    void h5.getStatus().then(applyStatus).finally(() => setLoading(false))
  }, [h5, applyStatus, t])

  if (loading) {
    return <div className="settings-form-body"><p className="settings-hint">{t.loading}</p></div>
  }
  if (!h5 || !status) {
    return <div className="settings-form-body"><p className="settings-hint">{error || t.apiUnavailableShort}</p></div>
  }

  const s = status.settings
  const runFn = async (fn: () => Promise<H5StatusPayload>) => {
    setBusy(true)
    try {
      applyStatus(await fn())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleToggleEnabled = (enabled: boolean) => {
    void runFn(() => h5.setConfig({ enabled }))
  }

  const rebuildQr = async (statusPayload: H5StatusPayload, token: string, address: string) => {
    const url = buildLaunchUrl(statusPayload, token, address || undefined)
    setLaunchUrl(url)
    if (url) {
      try {
        setQrDataUrl(await QRCode.toDataURL(url, { margin: 1, width: 220 }))
      } catch {
        setQrDataUrl(null)
      }
    } else {
      setQrDataUrl(null)
    }
  }

  const handleGenerateToken = async () => {
    setBusy(true)
    try {
      const res = await h5.generateToken()
      setRevealedToken(res.token)
      applyStatus(res.status)
      // Default to the best-detected (non-VPN) LAN address; the user can switch.
      const addr = res.status.server.lanAddress || ''
      setSelectedAddress(addr)
      await rebuildQr(res.status, res.token, addr)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleSelectAddress = (addr: string) => {
    setSelectedAddress(addr)
    if (status && revealedToken) void rebuildQr(status, revealedToken, addr)
  }

  const handleAddOrigin = () => {
    const o = newOrigin.trim()
    if (!o) return
    const next = Array.from(new Set([...s.allowedOrigins, o]))
    setNewOrigin('')
    void runFn(() => h5.setConfig({ allowedOrigins: next }))
  }

  const handleRemoveOrigin = (origin: string) => {
    void runFn(() => h5.setConfig({ allowedOrigins: s.allowedOrigins.filter((x) => x !== origin) }))
  }

  const handleSaveNetwork = () => {
    void runFn(() => h5.setConfig({
      host: localHost.trim() || '127.0.0.1',
      port: localPort,
      publicBaseUrl: localPublicBaseUrl.trim() || null,
    }))
  }

  const copyToken = (value: string) => {
    void navigator.clipboard?.writeText(value)
  }

  const h5Url = (() => {
    const base = s.publicBaseUrl?.trim()
    if (!base) return null
    const serverUrl = `http://${s.host === '0.0.0.0' ? t.hostPlaceholderIp : s.host}:${s.port}`
    return `${base.replace(/\/$/, '')}/?serverUrl=${encodeURIComponent(serverUrl)}`
  })()

  return (
    <div className="settings-form-body">
      <p className="settings-hint" style={{ marginTop: 0, marginBottom: 12, lineHeight: 1.6 }}>
        {t.intro1}
        <strong>{t.introStrong}</strong>
        {t.intro2}
      </p>

      <ToggleRow
        label={t.enable}
        description={status.server.running
          ? t.enableDescRunning(status.server.host, status.server.port)
          : t.enableDescIdle}
        checked={s.enabled}
        onChange={handleToggleEnabled}
      />

      {/* Token */}
      <div className="settings-group">
        <label className="settings-label">{t.token}</label>
        <p className="settings-hint" style={{ marginTop: 0, marginBottom: 8 }}>
          {s.hasToken ? t.tokenCurrent(s.tokenPreview ?? '') : t.tokenNone}
        </p>
        {revealedToken && (
          <div className="settings-banner settings-banner-warning" style={{ alignItems: 'center', gap: 8 }}>
            <code style={{ flex: 1, wordBreak: 'break-all', fontSize: 12 }}>{revealedToken}</code>
            <button className="settings-btn settings-btn-sm" onClick={() => copyToken(revealedToken)} title={t.copyTokenTitle}>
              <Copy size={13} /> {t.copy}
            </button>
          </div>
        )}
        {revealedToken && (
          <p className="settings-hint" style={{ color: 'var(--error)', marginTop: 4 }}>
            {t.tokenWarnOnce}
          </p>
        )}
        {revealedToken && s.hasToken && status.server.lanAddresses.length > 1 && (status.server.host === '0.0.0.0' || status.server.host === '::') && (
          <div className="settings-group" style={{ marginTop: 8 }}>
            <label className="settings-label">{t.lanLabel}</label>
            <div className="settings-select-wrapper">
              <select
                className="settings-select"
                value={selectedAddress}
                onChange={(e) => handleSelectAddress(e.target.value)}
              >
                {status.server.lanAddresses.map((a) => (
                  <option key={a} value={a}>{a}{a === status.server.lanAddress ? t.recommended : ''}</option>
                ))}
              </select>
            </div>
            <p className="settings-hint" style={{ marginTop: 4 }}>
              {t.lanHintPre}<code>192.168.x.x</code>{t.lanHintMid}<code>10.x</code>{t.lanHintSuf}
            </p>
          </div>
        )}
        {qrDataUrl && launchUrl && (
          <div style={{ marginTop: 10 }}>
            <p className="settings-hint" style={{ marginTop: 0, marginBottom: 6 }}>
              {t.qrHint}
            </p>
            <div style={{ textAlign: 'center' }}>
              <img src={qrDataUrl} alt={t.qrAlt} style={{ width: 200, height: 200, background: '#fff', borderRadius: 8, padding: 8 }} />
            </div>
            <div className="settings-banner" style={{ alignItems: 'center', gap: 8, marginTop: 6 }}>
              <code style={{ flex: 1, wordBreak: 'break-all', fontSize: 11 }}>{launchUrl}</code>
              <button className="settings-btn settings-btn-sm" onClick={() => copyToken(launchUrl)} title={t.copyLinkTitle}><Copy size={13} /> {t.copy}</button>
            </div>
          </div>
        )}
        {revealedToken && !launchUrl && (
          <p className="settings-hint" style={{ marginTop: 6, color: 'var(--error)' }}>
            {t.loopbackWarn1}<code>0.0.0.0</code>{t.loopbackWarn2}
          </p>
        )}
        <div className="settings-form-actions" style={{ justifyContent: 'flex-start', marginTop: 8 }}>
          <button className="settings-btn settings-btn-primary" disabled={busy} onClick={() => void handleGenerateToken()}>
            <RefreshCw size={14} /> {s.hasToken ? t.regenToken : t.genToken}
          </button>
        </div>
      </div>

      {/* Allowed origins */}
      <div className="settings-group">
        <label className="settings-label">{t.allowedOrigins}</label>
        <p className="settings-hint" style={{ marginTop: 0, marginBottom: 8 }}>
          {t.originsHintPre}<code>http://192.168.1.20:5173</code>{t.originsHintMid}<code>https://cc.example.com</code>{t.originsHintSuf}
        </p>
        <div className="settings-rule-editor">
          <div className="settings-rule-inputs">
            <input
              className="settings-input settings-rule-input"
              value={newOrigin}
              onChange={(e) => setNewOrigin(e.target.value)}
              placeholder="https://cc.example.com"
              onKeyDown={(e) => e.key === 'Enter' && handleAddOrigin()}
            />
            <button className="settings-rule-add-btn" disabled={busy} onClick={handleAddOrigin} title={t.addOriginTitle}><Plus size={14} /></button>
          </div>
          {s.allowedOrigins.length > 0 && (
            <div className="settings-rule-list">
              {s.allowedOrigins.map((origin) => (
                <div key={origin} className="settings-rule-item">
                  <div className="settings-rule-info">
                    <code className="settings-rule-cmd">{origin}</code>
                  </div>
                  <div className="settings-rule-actions">
                    <button disabled={busy} onClick={() => handleRemoveOrigin(origin)} title={t.delete}><Trash2 size={14} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Network */}
      <div className="settings-group">
        <label className="settings-label">{t.network}</label>
        <InputField
          label={t.hostLabel}
          value={localHost}
          onChange={setLocalHost}
          placeholder={t.hostPlaceholder}
          hint={t.hostHint}
        />
        <NumberField label={t.portLabel} value={localPort} onChange={setLocalPort} min={1} max={65535} />
        <InputField
          label={t.publicUrlLabel}
          value={localPublicBaseUrl}
          onChange={setLocalPublicBaseUrl}
          placeholder="https://cc.example.com"
          hint={t.publicUrlHint}
        />
        <div className="settings-form-actions" style={{ justifyContent: 'flex-start' }}>
          <button className="settings-btn settings-btn-primary" disabled={busy} onClick={handleSaveNetwork}>{t.saveNetwork}</button>
        </div>
      </div>

      {h5Url && (
        <div className="settings-group">
          <label className="settings-label">{t.h5UrlLabel}</label>
          <div className="settings-banner" style={{ alignItems: 'center', gap: 8 }}>
            <code style={{ flex: 1, wordBreak: 'break-all', fontSize: 12 }}>{h5Url}</code>
            <button className="settings-btn settings-btn-sm" onClick={() => copyToken(h5Url)} title={t.copyUrlTitle}>
              <Copy size={13} /> {t.copy}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="settings-hint" style={{ color: 'var(--error)', marginTop: 6 }}>{error}</p>
      )}
    </div>
  )
}
