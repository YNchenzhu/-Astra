import React, { useState } from 'react'
import { getStoredServerUrl, setStoredConnection, verifyConnection } from '../../services/h5/h5Connection'
import './H5ConnectScreen.css'

/**
 * Browser-mode connection gate. Shown when running in a browser without a
 * valid stored Server URL + Token. On success it persists the connection and
 * calls `onConnected` so the host can install the shim and mount the app.
 */
export const H5ConnectScreen: React.FC<{ onConnected: () => void }> = ({ onConnected }) => {
  const [serverUrl, setServerUrl] = useState(getStoredServerUrl())
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleConnect = async () => {
    const url = serverUrl.trim()
    const tk = token.trim()
    if (!url || !tk) {
      setError('请填写 Server URL 和 Token。')
      return
    }
    setBusy(true)
    setError(null)
    const result = await verifyConnection({ serverUrl: url, token: tk })
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setStoredConnection({ serverUrl: url, token: tk })
    onConnected()
  }

  return (
    <div className="h5-connect-root">
      <div className="h5-connect-card">
        <h1 className="h5-connect-title">连接到桌面端</h1>
        <p className="h5-connect-sub">
          在桌面端「设置 → 远程访问 (H5)」中启用并生成 Token，然后在此输入连接信息。
        </p>

        <label className="h5-connect-label">Server URL</label>
        <input
          className="h5-connect-input"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          placeholder="http://192.168.1.20:5174 或 https://cc.example.com"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="url"
        />

        <label className="h5-connect-label">H5 Token</label>
        <input
          className="h5-connect-input"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="桌面端生成的 Token"
          type="password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(e) => e.key === 'Enter' && void handleConnect()}
        />

        {error && <p className="h5-connect-error">{error}</p>}

        <button className="h5-connect-btn" disabled={busy} onClick={() => void handleConnect()}>
          {busy ? '连接中…' : '连接'}
        </button>
      </div>
    </div>
  )
}
