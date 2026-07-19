import { useEffect, useState } from 'react'
import App from '../../App'
import {
  getStoredConnection,
  verifyConnection,
} from '../../services/h5/h5Connection'
import { H5ConnectScreen } from './H5ConnectScreen'

type GateState = 'checking' | 'need-connect' | 'ready'
type StoredConnection = NonNullable<ReturnType<typeof getStoredConnection>>

export function H5BrowserGate({
  onEnter,
}: {
  onEnter: (connection: StoredConnection) => void
}): React.ReactElement {
  const [state, setState] = useState<GateState>(() =>
    getStoredConnection() ? 'checking' : 'need-connect',
  )

  const enterApp = () => {
    const connection = getStoredConnection()
    if (!connection) {
      setState('need-connect')
      return
    }
    onEnter(connection)
    setState('ready')
  }

  useEffect(() => {
    let cancelled = false
    const connection = getStoredConnection()
    if (!connection) return
    void verifyConnection(connection).then((result) => {
      if (cancelled) return
      if (result.ok) {
        onEnter(connection)
        setState('ready')
      } else {
        setState('need-connect')
      }
    })
    return () => {
      cancelled = true
    }
  }, [onEnter])

  if (state === 'ready') return <App />
  if (state === 'need-connect') return <H5ConnectScreen onConnected={enterApp} />
  return <div className="h5-connect-root">连接中…</div>
}
