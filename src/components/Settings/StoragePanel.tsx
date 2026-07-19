import { FolderOpen } from 'lucide-react'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useT } from '../../i18n'
import './StoragePanel.css'

function getFsOpenDialog():
  | Window['electronAPI']['fs']['openDialog']
  | undefined {
  if (typeof window === 'undefined') return undefined
  return window.electronAPI?.fs?.openDialog
}

export function StoragePanel() {
  const t = useT().settings.storage
  // 直接订阅 store：loadSettings 完成后 zustand 会自动触发重渲染。
  // 之前版本使用 useState(store.dataStoragePath) 把异步加载的值快照进本地
  // state，在 loadSettings 晚于组件挂载时会长期显示空路径直到用户手动选择。
  const dataStoragePath = useSettingsStore((s) => s.dataStoragePath)
  const agentStoragePath = useSettingsStore((s) => s.agentStoragePath)
  const setDataStoragePath = useSettingsStore((s) => s.setDataStoragePath)
  const setAgentStoragePath = useSettingsStore((s) => s.setAgentStoragePath)

  const handleSelectDataStoragePath = async () => {
    try {
      const openDialog = getFsOpenDialog()
      if (!openDialog) {
        console.error('Electron API not available')
        return
      }
      const result = await openDialog({
        title: t.selectDataDialog,
        properties: ['openDirectory'],
      })
      if (!result.canceled && result.paths.length > 0) {
        setDataStoragePath(result.paths[0])
      }
    } catch (error) {
      console.error('Failed to select data storage path:', error)
    }
  }

  const handleSelectAgentStoragePath = async () => {
    try {
      const openDialog = getFsOpenDialog()
      if (!openDialog) {
        console.error('Electron API not available')
        return
      }
      const result = await openDialog({
        title: t.selectAgentDialog,
        properties: ['openDirectory'],
      })
      if (!result.canceled && result.paths.length > 0) {
        setAgentStoragePath(result.paths[0])
      }
    } catch (error) {
      console.error('Failed to select agent storage path:', error)
    }
  }

  return (
    <div className="storage-panel">
      <div className="storage-card">
        <h3 className="storage-card-title">{t.dataTitle}</h3>
        <p className="storage-description">
          {t.dataDesc}
        </p>
        <div className="storage-path-row">
          <input
            type="text"
            value={dataStoragePath}
            readOnly
            placeholder={t.notSet}
            className="storage-path-field"
            title={dataStoragePath || undefined}
            aria-label={t.dataAria}
          />
          <button
            type="button"
            onClick={handleSelectDataStoragePath}
            className="storage-select-btn"
            title={t.selectDataTitle}
          >
            <FolderOpen size={16} aria-hidden />
            {t.browse}
          </button>
        </div>
      </div>

      <div className="storage-card">
        <h3 className="storage-card-title">{t.agentTitle}</h3>
        <p className="storage-description">
          {t.agentDesc}
        </p>
        <div className="storage-path-row">
          <input
            type="text"
            value={agentStoragePath}
            readOnly
            placeholder={t.notSet}
            className="storage-path-field"
            title={agentStoragePath || undefined}
            aria-label={t.agentAria}
          />
          <button
            type="button"
            onClick={handleSelectAgentStoragePath}
            className="storage-select-btn"
            title={t.selectAgentTitle}
          >
            <FolderOpen size={16} aria-hidden />
            {t.browse}
          </button>
        </div>
      </div>

      <div className="storage-info">
        <p>
          <strong>{t.infoMemoryStrong}</strong>{t.infoMemoryPart1}<code>.claude/memory</code>{t.infoMemoryPart2}<code>星构Astra-data/memory/user</code>{t.infoMemoryPart3}
        </p>
        <p>
          <strong>{t.infoTipStrong}</strong>{t.infoTipText}
        </p>
      </div>
    </div>
  )
}
