import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, KeyRound, QrCode, RefreshCw, Unlink } from 'lucide-react'
import type { ImConfigResult, ImConfigView } from '../../types/electronAPI'
import { InputField } from '../AIChat/settingsControls'
import { useT } from '../../i18n'

/**
 * Settings → 微信 / IM 面板。
 *
 * 管理 `~/.claude/adapters.json`：微信凭证（accountId / botToken / baseUrl）、
 * 适配器连接的 Server URL、默认工作目录、允许用户名单，以及生成一次性配对码。
 * 微信扫码绑定本身不在桌面端内完成——需用其它方式获取 botToken/accountId 后
 * 填入此处（与 upstream 的「Settings > IM」配置管理对齐）。
 */
export const IMPanel: React.FC = () => {
  const t = useT().settings.im
  type ImApi = {
    getConfig: () => Promise<ImConfigResult>
    setConfig: (patch: Record<string, unknown>) => Promise<ImConfigResult>
    generatePairingCode: () => Promise<{ code: string; expiresAt: number; config: ImConfigView }>
    wechatStartLogin: () => Promise<{ sessionKey: string; qrDataUrl: string; message: string }>
    wechatPollLogin: (sessionKey: string) => Promise<{ connected: boolean; status: string; message: string; config: ImConfigView }>
    wechatUnbind: () => Promise<{ config: ImConfigView }>
    wechatSidecarStatus: () => Promise<{ running: boolean; error: string | null; bundleAvailable: boolean }>
    wechatSidecarStart: () => Promise<{ running: boolean; error: string | null; bundleAvailable: boolean }>
    wechatSidecarStop: () => Promise<{ running: boolean; error: string | null; bundleAvailable: boolean }>
  }
  const im = (window as unknown as { electronAPI?: { im?: ImApi } }).electronAPI?.im

  const [config, setConfig] = useState<ImConfigView | null>(null)
  const [suggested, setSuggested] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pairingCode, setPairingCode] = useState<string | null>(null)

  // Local editable fields.
  const [accountId, setAccountId] = useState('')
  const [botToken, setBotToken] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [serverUrl, setServerUrl] = useState('')
  const [defaultProjectDir, setDefaultProjectDir] = useState('')
  const [allowedUsers, setAllowedUsers] = useState('')

  // WeChat QR binding state.
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [sessionKey, setSessionKey] = useState<string | null>(null)
  const [bindStatus, setBindStatus] = useState('')
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sidecar (bundled adapter process) state.
  const [sidecar, setSidecar] = useState<{ running: boolean; error: string | null; bundleAvailable: boolean } | null>(null)
  const refreshSidecar = useCallback(() => {
    if (!im) return
    void im.wechatSidecarStatus().then(setSidecar).catch(() => {})
  }, [im])

  const apply = useCallback((res: ImConfigResult) => {
    setConfig(res.config)
    setSuggested(res.suggestedServerUrl)
    setAccountId(res.config.wechat.accountId)
    setBaseUrl(res.config.wechat.baseUrl)
    setServerUrl(res.config.serverUrl)
    setDefaultProjectDir(res.config.defaultProjectDir)
    setAllowedUsers(res.config.wechat.allowedUsers.join(', '))
    // Show masked preview as placeholder; leave the editable token blank.
    setBotToken('')
  }, [])

  useEffect(() => {
    if (!im) {
      setLoading(false)
      setError(t.apiUnavailable)
      return
    }
    void im.getConfig().then(apply).finally(() => setLoading(false))
    refreshSidecar()
  }, [im, apply, refreshSidecar, t])

  // Poll WeChat QR login status while a binding session is active.
  useEffect(() => {
    if (!im || !sessionKey) return
    let cancelled = false
    const poll = async () => {
      try {
        const res = await im.wechatPollLogin(sessionKey)
        if (cancelled) return
        setBindStatus(res.message)
        if (res.connected) {
          setQrDataUrl(null)
          setSessionKey(null)
          apply({ config: res.config, suggestedServerUrl: suggested })
          refreshSidecar()
          return
        }
        if (res.status === 'expired' || res.status === 'not_started') {
          setQrDataUrl(null)
          setSessionKey(null)
          return
        }
      } catch (e) {
        if (!cancelled) setBindStatus(e instanceof Error ? e.message : t.pollFailed)
      }
      if (!cancelled) pollTimer.current = setTimeout(() => void poll(), 1500)
    }
    pollTimer.current = setTimeout(() => void poll(), 1500)
    return () => {
      cancelled = true
      if (pollTimer.current) clearTimeout(pollTimer.current)
    }
    // `suggested` is intentionally read at poll time, not a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [im, sessionKey, apply])

  if (loading) return <div className="settings-form-body"><p className="settings-hint">{t.loading}</p></div>
  if (!im || !config) return <div className="settings-form-body"><p className="settings-hint">{error || t.apiUnavailableShort}</p></div>

  const run = async (fn: () => Promise<ImConfigResult>) => {
    setBusy(true)
    setError(null)
    try {
      apply(await fn())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleSave = () => {
    void run(() =>
      im.setConfig({
        serverUrl: serverUrl.trim(),
        defaultProjectDir: defaultProjectDir.trim(),
        wechat: {
          accountId: accountId.trim(),
          baseUrl: baseUrl.trim(),
          // Empty → keep existing token (don't overwrite with blank).
          ...(botToken.trim() ? { botToken: botToken.trim() } : {}),
          allowedUsers: allowedUsers.split(',').map((s) => s.trim()).filter(Boolean),
        },
      }),
    ).then(refreshSidecar)
  }

  const handleSidecarStart = () => {
    setBusy(true)
    void im.wechatSidecarStart().then(setSidecar).finally(() => setBusy(false))
  }
  const handleSidecarStop = () => {
    setBusy(true)
    void im.wechatSidecarStop().then(setSidecar).finally(() => setBusy(false))
  }

  const handleGeneratePairing = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await im.generatePairingCode()
      setPairingCode(res.code)
      setConfig(res.config)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleStartBind = async () => {
    setBusy(true)
    setError(null)
    setBindStatus('')
    try {
      const res = await im.wechatStartLogin()
      setQrDataUrl(res.qrDataUrl)
      setSessionKey(res.sessionKey)
      setBindStatus(res.message)
    } catch (e) {
      setError(e instanceof Error ? e.message : t.qrFailed)
    } finally {
      setBusy(false)
    }
  }

  const handleUnbind = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await im.wechatUnbind()
      setQrDataUrl(null)
      setSessionKey(null)
      setBindStatus('')
      apply({ config: res.config, suggestedServerUrl: suggested })
      refreshSidecar()
    } catch (e) {
      setError(e instanceof Error ? e.message : t.unbindFailed)
    } finally {
      setBusy(false)
    }
  }

  const copy = (v: string) => void navigator.clipboard?.writeText(v)
  const w = config.wechat
  const bound = w.hasBotToken && Boolean(w.accountId)

  return (
    <div className="settings-form-body">
      <p className="settings-hint" style={{ marginTop: 0, marginBottom: 12, lineHeight: 1.6 }}>
        {t.intro1}<code>~/.claude/adapters.json</code>{t.intro2}
        <strong>{t.introStrong}</strong>{t.intro3}
      </p>

      {/* Connection */}
      <div className="settings-group">
        <label className="settings-label">{t.connection}</label>
        <InputField
          label={t.serverUrlLabel}
          value={serverUrl}
          onChange={setServerUrl}
          placeholder={suggested || 'ws://127.0.0.1:5174'}
          hint={suggested ? t.serverUrlHintRunning(suggested) : t.serverUrlHintIdle}
        />
        <InputField
          label={t.defaultDir}
          value={defaultProjectDir}
          onChange={setDefaultProjectDir}
          placeholder={t.defaultDirPlaceholder}
          hint={t.defaultDirHint}
        />
      </div>

      {/* WeChat QR binding */}
      <div className="settings-group">
        <label className="settings-label">{t.binding}</label>
        {bound ? (
          <>
            <p className="settings-hint" style={{ marginTop: 0, marginBottom: 8 }}>
              {t.boundInfoPre}<code>{w.accountId}</code>{t.boundInfoSuf}
            </p>
            <div className="settings-form-actions" style={{ justifyContent: 'flex-start' }}>
              <button className="settings-btn settings-btn-secondary" disabled={busy} onClick={() => void handleStartBind()}>
                <QrCode size={14} /> {t.rescan}
              </button>
              <button className="settings-btn settings-btn-secondary" disabled={busy} onClick={() => void handleUnbind()}>
                <Unlink size={14} /> {t.unbind}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="settings-hint" style={{ marginTop: 0, marginBottom: 8 }}>
              {t.bindHint}
            </p>
            <div className="settings-form-actions" style={{ justifyContent: 'flex-start' }}>
              <button className="settings-btn settings-btn-primary" disabled={busy || Boolean(sessionKey)} onClick={() => void handleStartBind()}>
                <QrCode size={14} /> {sessionKey ? t.qrGenerated : t.scanBind}
              </button>
            </div>
          </>
        )}
        {qrDataUrl && (
          <div style={{ marginTop: 12, textAlign: 'center' }}>
            <img src={qrDataUrl} alt={t.qrAlt} style={{ width: 220, height: 220, background: '#fff', borderRadius: 8, padding: 8 }} />
          </div>
        )}
        {bindStatus && <p className="settings-hint" style={{ marginTop: 8 }}>{bindStatus}</p>}
      </div>

      {/* WeChat credentials */}
      <div className="settings-group">
        <label className="settings-label">{t.credentials}</label>
        <InputField label={t.accountId} value={accountId} onChange={setAccountId} placeholder={t.accountIdPlaceholder} />
        <div className="settings-group">
          <label className="settings-label">{t.botToken}</label>
          <input
            type="password"
            className="settings-input"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder={w.hasBotToken ? t.botTokenSet(w.botTokenPreview ?? '') : t.botTokenPlaceholder}
          />
        </div>
        <InputField
          label={t.baseUrl}
          value={baseUrl}
          onChange={setBaseUrl}
          placeholder="https://ilinkai.weixin.qq.com"
          hint={t.baseUrlHint}
        />
      </div>

      {/* Authorization */}
      <div className="settings-group">
        <label className="settings-label">{t.authorization}</label>
        <InputField
          label={t.allowedUsersLabel}
          value={allowedUsers}
          onChange={setAllowedUsers}
          placeholder="userId1, userId2"
        />
        {w.pairedUsers.length > 0 && (
          <p className="settings-hint" style={{ marginTop: 4 }}>
            {t.pairedUsers(w.pairedUsers.map((p) => p.displayName || String(p.userId)).join('、'))}
          </p>
        )}
      </div>

      <div className="settings-form-actions" style={{ justifyContent: 'flex-start' }}>
        <button className="settings-btn settings-btn-primary" disabled={busy} onClick={handleSave}>{t.saveConfig}</button>
      </div>

      {/* Pairing code */}
      <div className="settings-group">
        <label className="settings-label">{t.pairingCode}</label>
        <p className="settings-hint" style={{ marginTop: 0, marginBottom: 8 }}>
          {t.pairingHint}
          {config.pairing.active ? t.pairingActive : ''}
        </p>
        {pairingCode && (
          <div className="settings-banner settings-banner-warning" style={{ alignItems: 'center', gap: 8 }}>
            <code style={{ flex: 1, fontSize: 18, letterSpacing: 2 }}>{pairingCode}</code>
            <button className="settings-btn settings-btn-sm" onClick={() => copy(pairingCode)}><Copy size={13} /> {t.copy}</button>
          </div>
        )}
        <div className="settings-form-actions" style={{ justifyContent: 'flex-start', marginTop: 8 }}>
          <button className="settings-btn settings-btn-primary" disabled={busy} onClick={() => void handleGeneratePairing()}>
            <KeyRound size={14} /> {t.generatePairing}
          </button>
        </div>
      </div>

      {/* Adapter process (auto-managed sidecar) */}
      <div className="settings-group">
        <label className="settings-label">{t.adapterProcess}</label>
        {sidecar?.bundleAvailable ? (
          <>
            <p className="settings-hint" style={{ marginTop: 0, marginBottom: 8 }}>
              {t.sidecarHintPre}
              <strong style={{ color: sidecar.running ? 'var(--accent)' : 'var(--text-secondary)' }}>
                {sidecar.running ? t.sidecarRunning : t.sidecarStopped}
              </strong>
            </p>
            <div className="settings-form-actions" style={{ justifyContent: 'flex-start' }}>
              {sidecar.running ? (
                <button className="settings-btn settings-btn-secondary" disabled={busy} onClick={handleSidecarStop}>{t.stop}</button>
              ) : (
                <button className="settings-btn settings-btn-primary" disabled={busy} onClick={handleSidecarStart}>{t.start}</button>
              )}
              <button className="settings-btn settings-btn-secondary" disabled={busy} onClick={refreshSidecar}><RefreshCw size={13} /> {t.refresh}</button>
            </div>
            {sidecar.error && !sidecar.running && (
              <p className="settings-hint" style={{ marginTop: 6 }}>{sidecar.error}</p>
            )}
          </>
        ) : (
          <>
            <p className="settings-hint" style={{ marginTop: 0, marginBottom: 8 }}>
              {t.sidecarUnavailable1}<code>npm run build:adapter</code>{t.sidecarUnavailable2}
            </p>
            <div className="settings-banner" style={{ alignItems: 'center', gap: 8 }}>
              <code style={{ flex: 1, wordBreak: 'break-all', fontSize: 12 }}>
                cd adapters &amp;&amp; npx bun install &amp;&amp; ADAPTER_SERVER_URL={suggested || 'ws://127.0.0.1:5174'} npx bun run wechat
              </code>
              <button className="settings-btn settings-btn-sm" onClick={() => copy(`cd adapters && npx bun install && ADAPTER_SERVER_URL=${suggested || 'ws://127.0.0.1:5174'} npx bun run wechat`)}>
                <RefreshCw size={13} /> {t.copy}
              </button>
            </div>
          </>
        )}
      </div>

      {error && <p className="settings-hint" style={{ color: 'var(--error)', marginTop: 6 }}>{error}</p>}
    </div>
  )
}
