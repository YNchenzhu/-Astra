# Tool 子系统闭环分析报告

> 生成时间: 2025-07-23  
> 分析范围: `electron/tools/` + `electron/orchestration/` + `src/tools/` + `src/stores/` + `electron/ipc/` + `electron/preload/`

---

## 概览: 发现 9 大类未闭环问题

| # | 问题 | 严重度 | 类型 |
|---|------|--------|------|
| G1 | 前端 `disabledTools` 设置永不传回主进程 | **P0 功能性断裂** | 闭环断裂 |
| G2 | 前端工具注册表是孤立的重复副本 | **P0 架构性断裂** | 闭环断裂 |
| G3 | `useAgenticLoop` 是未接入的渲染进程死代码 | **P1 死代码** | 闭环断裂 |
| G4 | 预加载 IPC 通道分散在两个文件中注册 | **P1 维护性** | 分散 |
| G5 | 编排子系统代码残留但入口已删除 | **P1 死代码** | 闭环断裂 |
| G6 | 前端 Tool 类的 `execute()` 都是 throw stub | **P2 设计异味** | 架构 |
| G7 | 前端/后端工具 Schema 不一致 | **P2 数据不一致** | 架构 |
| G8 | 编排集成测试仍引用已删除的 feature flag | **P2 死测试** | 测试 |
| G9 | 前端 4 工具 vs 后端 60+ 工具 — 数量悬殊 | **P3 信息差** | 架构 |

---

## G1: 前端 `disabledTools` 设置永不传回主进程 [P0]

### 涉及文件
- `src/stores/settings/slices/toolsSlice.ts` — 定义 `disabledTools` 状态
- `src/stores/useToolRegistry.ts` — 前端工具 enable/disable
- `src/services/tools/initializeTools.ts` — 启动时从前端同步 disabledTools
- `electron/tools/toolLoadFlags.ts` — 主进程通过环境变量 `ASTRA_DISABLED_TOOLS` 禁用工具
- `electron/tools/schema.ts:309` — `isToolRuntimeDisabled()` 在主进程过滤工具列表

### 数据流现状

```
Settings → ToolsPanel 勾选
    ↓
toolsSlice.disabledTools (渲染进程 zustand)
    ↓
initializeTools() 启动时读取 disabledTools → useToolRegistry.disableTool()
    ↓
❌ 到此为止！从不发送到主进程

主进程侧:
    ↓
process.env.ASTRA_DISABLED_TOOLS (环境变量)
    ↓
isToolRuntimeDisabled() (toolLoadFlags.ts)
    ↓
getToolDefinitions() 过滤 (schema.ts:309)
```

### 断裂点
`src/stores/settings/slices/toolsSlice.ts` 注释明确说 `disabledTools` 是"the source of truth that this registry should sync from on launch" (第 41-42 行)。但 `initializeTools.ts` 只在启动时同步一次到 **渲染进程的** zustand store，从不通过 IPC 发送给主进程。

**后果**: 用户在 Settings → 工具面板中禁用工具后:
- 前端 toggle 视觉上生效
- 但主进程的 `getToolDefinitions()` 仍然列出这些工具
- AI 模型仍然可以调用它们
- **grep 确认**: `electron/` 目录下零匹配 `disabledTools`

### 修复建议
新增 IPC 通道 `settings:sync-disabled-tools`，在 `setDisabledTools` / `toggleDisabledTool` 中调用，主进程侧接收后更新 `ASTRA_DISABLED_TOOLS` 或迁移 `toolLoadFlags.ts` 支持内存运行时禁用。

---

## G2: 前端工具注册表是孤立的重复副本 [P0]

### 涉及文件
- `src/services/tools/toolRegistry.ts` — 渲染进程工具注册表单例 (4 个工具)
- `electron/tools/registry.ts` — 主进程工具注册表单例 (60+ 工具)
- `src/stores/useToolRegistry.ts` — zustand 工具注册表 (4 个工具)
- `src/services/tools/initializeTools.ts` — 前端工具初始化

### 两个注册表的工具数量

| 注册表 | 位置 | 工具数 | 实际执行 |
|--------|------|--------|----------|
| `electron/tools/registry.ts` | 主进程 | ~60+ | ✅ `tool.execute()` 真实执行 |
| `src/services/tools/toolRegistry.ts` | 渲染进程 | 4 | ❌ `execute()` → throw Error |
| `src/stores/useToolRegistry` | 渲染进程 zustand | 4 | ❌ 仅供 UI 展示 |

### 断裂点
前端注册表只有 `BashTool`, `FileReadTool`, `FileWriteTool`, `WebSearchTool` 四个工具，且它们的 `execute()` 都抛异常（设计意图是"只用于 Settings 面板展示"）。但:

1. 前端 `ToolsPanel.tsx` 调用 `useToolRegistry` 的 `tools` 列表渲染工具卡片
2. 同时 `ToolsPanel.tsx:145-147` 还调用了 `window.electronAPI.tools.list()` 获取主进程工具列表
3. 这两份列表从未合并，UI 显示两份独立的工具集

### 修复建议
统一方案二选一:
- **方案 A**: 删除前端 `toolRegistry`，`ToolsPanel` 完全从主进程 IPC 获取工具列表
- **方案 B**: 主进程通过 IPC 推送完整工具列表到渲染进程，前端 zustand 作为镜像缓存

---

## G3: `useAgenticLoop` 是未接入的渲染进程死代码 [P1]

### 涉及文件
- `src/stores/useToolRegistry.ts:136-396` — `useAgenticLoop` store

### 问题
`useAgenticLoop` 是一个完整的 Zustand store，包含:
- `runAgenticLoop()` 方法 (~200 行)
- 模拟的 agentic 循环（消息处理、权限请求、工具执行）
- `INITIAL_LOOP_STATE` 初始状态

但是代码注释 (第 217-219 行) 明确说:

```typescript
// The actual API call would happen here via the Electron main process
// For now, this is the structural loop that the backend will plug into
```

真实的 agentic 循环运行在 `electron/ai/agenticLoop.ts`（主进程），这个渲染进程版本从未被连接。这是一个"计划留给后端接入"的占位骨架，但在主进程实现完成后从未被删除。

### 修复建议
- 如果前端确实不需要此 store，删除它
- 如果需要前端 agentic 循环状态展示，重新设计为从主进程 IPC 读取状态的轻量订阅

---

## G4: 预加载 IPC 通道在两个文件中分散注册 [P1]

### 涉及文件
- `electron/ipc/handlers/toolHandlers.ts` — 注册 `tool:list` 和 `tool:execute-ui`
- `electron/ai/advancedTools.ts` — 注册 `tool:glob`, `tool:grep`, `tool:web-fetch`, `tool:web-search`, `tool:brave-test-key`, `tool:baidu-test-key`, `tool:inspect-model-visible`
- `electron/preload/tools.ts` — 预加载桥接层，声明所有 IPC 通道

### 问题
预加载层 `buildToolsApi()` (preload/tools.ts:90-102) 声明了 9 个 IPC 通道:

| 通道 | 处理器所在文件 |
|------|---------------|
| `tool:list` | `electron/ipc/handlers/toolHandlers.ts` |
| `tool:execute-ui` | `electron/ipc/handlers/toolHandlers.ts` |
| `tool:glob` | `electron/ai/advancedTools.ts` |
| `tool:grep` | `electron/ai/advancedTools.ts` |
| `tool:web-fetch` | `electron/ai/advancedTools.ts` |
| `tool:web-search` | `electron/ai/advancedTools.ts` |
| `tool:brave-test-key` | `electron/ai/advancedTools.ts` |
| `tool:baidu-test-key` | `electron/ai/advancedTools.ts` |
| `tool:inspect-model-visible` | `electron/ai/advancedTools.ts` |

**分裂点**: `ipc/handlers/toolHandlers.ts` 文件头注释说 "Tool-registry IPC handlers exposed directly to the renderer UI"，但实际上只有 2/9 的通道在此注册。其余 7 个通道在 `ai/advancedTools.ts` 的 `registerAdvancedToolHandlers()` 中注册。

这违反了单一职责原则——IPC 通道的完整清单需要跨两个文件搜索。

### 修复建议
将 `advancedTools.ts` 中的 IPC 处理器迁移到 `ipc/handlers/toolHandlers.ts`，或至少添加交叉引用注释。

---

## G5: 编排子系统代码残留但入口已删除 [P1]

### 涉及文件
- `electron/orchestration/` — 完整编排子系统 (~40 个文件)
- `electron/orchestration/TOOL_ORCHESTRATION_MIGRATION.md` — 迁移记录
- `electron/orchestration/FEATURE_FLAGS.md` — 特性开关文档
- `electron/agents/multiAgentOrchestratorSingleton.ts` — 仍引用编排器

### 问题
根据 `TOOL_ORCHESTRATION_MIGRATION.md`:
- **已删除**: `POLE_TOOL_ORCHESTRATION` 环境变量、`agenticToolBatchOrchestrated.ts`
- **已替换**: 所有工具批次现在通过 `DefaultToolRuntimePort` 执行

但编排子系统的以下代码**仍然存在并被导入**:
- `electron/orchestration/toolOrchestrator.ts` — ToolOrchestrator
- `electron/orchestration/policyEngine.ts` — PolicyEngine
- `electron/orchestration/toolScheduler.ts` — ToolScheduler
- `electron/orchestration/resourceQuota.ts` — ResourceQuota
- 全部 `__tests__/` 测试文件

`multiAgentOrchestratorSingleton.ts:50-96` 仍然检查 `POLE_TOOL_ORCHESTRATION` 并返回 `ToolOrchestrator`，但 flag 已删除。

### 修复建议
- 确认编排子系统是否需要保留（如果是，恢复功能）
- 如果已废弃，清理整个 `electron/orchestration/` 目录
- 更新 `multiAgentOrchestratorSingleton.ts` 移除死引用

---

## G6: 前端 Tool 类的 `execute()` 都是 throw stub [P2]

### 涉及文件
- `src/tools/FileWriteTool.ts:31-37`
- `src/tools/FileReadTool.ts:35-41`
- `src/tools/BashTool.ts` (类似)

### 问题
```typescript
// FileWriteTool.ts
async execute(_input: Record<string, unknown>): Promise<string> {
  throw new Error(
    'FileWriteTool.execute() called on the renderer. File writes run in ' +
    'the main process via electron/ai/toolWriteFile.ts; the ' +
    'renderer-side tool is metadata-only (Settings → Tools panel).',
  )
}
```

这些类实现了 `ITool` 接口但 `execute()` 是故意的不完整实现。它们是"元数据壳"，存在理由仅是为了 Settings → Tools 面板能列出它们。

### 修复建议
- 为"纯元数据工具"创建专门的接口/类型，不需要 `execute()` 方法
- 或者将 ToolsPanel 完全迁移到 IPC 获取工具列表，删除这些 stub 类

---

## G7: 前端/后端工具 Schema 不一致 [P2]

### 涉及文件
- `src/tools/FileWriteTool.ts:16-29` — 前端 `inputSchema`
- `electron/tools/registryBuiltinTools.ts:132-160` — 后端 `write_file` 的 `inputSchema`
- `src/tools/WebSearchTool.ts` — 前端 WebSearch schema
- `electron/tools/registryBuiltinTools.ts:658-689` — 后端 `WebSearch` schema

### 差异
**FileWriteTool**:
- 前端: `{ path: string, content: string }` + required: ['path', 'content']
- 后端: `{ filePath: string, content: string }` + required: ['filePath', 'content']
- **参数名不同**: `path` vs `filePath`

**WebSearchTool**:
- 前端: 缺少 `engine` (auto/brave/baidu/ddg) 和 `freshness` 参数
- 后端: 包含完整参数

### 后果
Settings → Tools 面板展示的 schema 与实际 AI 模型使用的 schema 不一致——用户看到的工具参数列表不准确。

---

## G8: 编排集成测试仍引用已删除的 feature flag [P2]

### 涉及文件
- `electron/orchestration/__tests__/integration.test.ts`

### 问题
该测试文件 (155 行) 使用 `POLE_TOOL_ORCHESTRATION` 环境变量来切换测试模式:
```typescript
delete process.env.POLE_TOOL_ORCHESTRATION  // 测试 "unset"
process.env.POLE_TOOL_ORCHESTRATION = '0'    // 测试 "disabled"
process.env.POLE_TOOL_ORCHESTRATION = '1'    // 测试 "enabled"
```

由于该 flag 已被删除（per TOOL_ORCHESTRATION_MIGRATION.md），所有 `POLE_TOOL_ORCHESTRATION = '1'` 的测试路径现在测试的是**永远不会被执行的死代码**。

### 修复建议
- 如果编排子系统已废弃，删除此测试文件
- 如果编排子系统保留，更新 flag 名称为实际使用的 flag

---

## G9: 前端 4 工具 vs 后端 60+ 工具的悬殊 [P3]

### 数据
- **前端注册**: 4 个工具 (Bash, FileRead, FileWrite, WebSearch)
- **后端注册**: 60+ 工具 (read_file, write_file, edit_file, multi_edit_file, glob, grep, list_files, web_fetch, WebSearch, bash, PowerShell, Agent, Task*, Team*, Cron*, LSP, Skill, DiscoverSkills, MemdirScan, + 26 Excel 工具 + 5 Word 工具 + MCP 动态工具 + ...)

### 问题
`ToolsPanel.tsx` 同时显示两个来源的工具:
1. `useToolRegistry.tools` — 前端 4 个工具
2. `electronAPI.tools.list()` → 主进程工具定义

这两份列表格式不同，从未合并。用户看到的是一个分区的工具列表，但前端工具区显示了与实际执行无关的元数据。

---

## 总结

### 核心闭环断裂 (需优先修复)

```
                    Settings UI
                        │
              ┌─────────┼─────────┐
              │         │         │
         disabledTools    │    tool toggle
              │         │         │
              ▼         │         ▼
     toolsSlice.ts       │   useToolRegistry
     (渲染进程)          │   (渲染进程 zustand)
              │         │         │
              ✗         │         ✗
         从未发送         │     只影响前端 store
         到主进程         │
              │         │         │
     ─ ─ ─ ─ ┼ ─ ─ ─ ─ ┼ ─ ─ ─ ─│─ IPC 边界
              │         │         │
              ▼         │         ▼
    toolLoadFlags.ts     │    electron/tools/registry.ts
    (仅读环境变量)       │    (60+ 工具, 真正的执行引擎)
```

**只有两条路径能影响主进程的工具列表:**
1. `ASTRA_DISABLED_TOOLS` 环境变量 (需要重启应用)
2. `toolRegistry.unregister()` (仅 MCP 同步时使用)

**用户通过 UI 做的任何修改都不影响 AI 能看到的工具。**

### 建议修复优先级

1. **P0**: 建立 `disabledTools` 的 IPC 同步通道
2. **P0**: 统一前端/后端工具注册表
3. **P1**: 删除 `useAgenticLoop` 死代码
4. **P1**: 合并分散的 IPC 处理器
5. **P1**: 清理编排子系统残留
6. **P2**: 删除前端 stub Tool 类或重构为纯元数据结构
7. **P2**: 统一前后端 Schema
8. **P2**: 更新编排集成测试
