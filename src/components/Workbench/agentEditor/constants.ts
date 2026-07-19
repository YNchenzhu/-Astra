import type {
  EditableAgentField,
  EditableAgentPatch,
} from '../../../stores/workbenchDraftStore'

export type TabId = 'basic' | 'prompt' | 'capability' | 'model' | 'permission' | 'hooks' | 'coordination'

/**
 * "运行时协议工具"名字 —— 与 `electron/agents/types.ts::ALWAYS_AVAILABLE_SUBAGENT_TOOLS`
 * 保持一致(那个是真源,运行时真正做注入;这里仅用于工作台 UI 标注"无需勾选"的徽章)。
 *
 * 新增/修改时务必两边同步:
 *   - electron/agents/types.ts → 影响运行时工具面
 *   - src/components/Workbench/AgentEditor.tsx → 影响配置 UI 徽章
 */
export const ALWAYS_AVAILABLE_SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'TodoWrite',
])

export const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'basic', label: '基本' },
  { id: 'prompt', label: '提示词' },
  { id: 'capability', label: '能力' },
  { id: 'model', label: '运行' },
  { id: 'permission', label: '权限' },
  { id: 'hooks', label: '钩子' },
  { id: 'coordination', label: '协调' },
]

/** Field editor callback signature — used by every tab body.
 *  `value` is untyped on the signature boundary because a single Field
 *  component handles many shapes (string / number / boolean / enum),
 *  but the caller cast matches its draft field's type. */
export type OnFieldChange = <K extends EditableAgentField>(
  field: K,
  value: EditableAgentPatch[K],
) => void
