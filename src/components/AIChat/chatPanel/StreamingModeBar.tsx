import type { DiffPermissionMode, PermissionMode } from '../../../types'

/** Shown above the transcript while the assistant is streaming — same labels as ChatInput toolbars. */
export function StreamingModeBar({
  permissionMode,
  diffPermissionMode,
}: {
  permissionMode: PermissionMode
  diffPermissionMode: DiffPermissionMode
}) {
  return (
    <div className="chat-streaming-toolbar" role="status" aria-live="polite">
      <span className="chat-streaming-toolbar-hint">输出中 · 当前模式</span>
      <div
        className="chat-mode-badges chat-mode-badges--streaming"
        title="与输入栏左侧一致：工具权限与文件变更策略"
      >
        <span
          className={`chat-mode-badge ${
            permissionMode === 'plan'
              ? 'chat-mode-badge--perm-plan'
              : permissionMode === 'bypassPermissions'
                ? 'chat-mode-badge--perm-bypass'
                : 'chat-mode-badge--perm-default'
          }`}
        >
          {permissionMode === 'plan'
            ? 'Plan 模式'
            : permissionMode === 'bypassPermissions'
              ? '放行'
              : '标准'}
        </span>
        <span
          className={`chat-mode-badge ${
            diffPermissionMode === 'bypassPermissions'
              ? 'chat-mode-badge--diff-auto'
              : 'chat-mode-badge--diff-review'
          }`}
        >
          {diffPermissionMode === 'bypassPermissions' ? '自动写入' : '变更审核'}
        </span>
      </div>
    </div>
  )
}
