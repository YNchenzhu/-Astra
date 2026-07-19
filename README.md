# 星构Astra — AI-First Code Editor

基于 **Electron 41 + React 19 + Vite 8 + TypeScript 5.9** 构建的 AI 驱动桌面代码编辑器。内置多模型统一接入、Agentic 工具循环、编排内核（OrchestrationKernel）、多智能体协作、LSP 代码智能、MCP 协议、本地向量检索，并支持通过 H5 / 即时通讯（微信、钉钉、Telegram、飞书）远程驱动 Agent。

> 应用内部代号 / 包名为 `astra`（`appId: com.taichu.app`），当前版本 `0.4.0`。

---

## 目录

- [核心能力](#核心能力)
- [快速开始](#快速开始)
- [系统架构总览](#系统架构总览)
- [项目结构](#项目结构)
- [技术栈](#技术栈)
- [核心架构详解](#核心架构详解)
- [工具系统](#工具系统)
- [远程接入（H5 + IM）](#远程接入h5--im)
- [安全模型](#安全模型)
- [快捷键](#快捷键)
- [开发指南](#开发指南)
- [测试](#测试)
- [打包发布](#打包发布)
- [许可证](#许可证)

---

## 核心能力

### AI 内核
- **多模型统一接入** — Anthropic Claude（直连 / Bedrock / Vertex / Foundry）、OpenAI（GPT 系列 / o 系列）、Google Gemini（2.5 Pro / Flash），以及兼容 Anthropic / OpenAI 协议的第三方网关（含智谱 Zhipu 网关）。统一流式接口，自动在 `tool_use ↔ function_calling ↔ functionDeclarations` 之间转换工具与消息格式。
- **Agentic Loop** — 模型输出 → `tool_use` → 执行 → `tool_result` → 继续的工具调用循环，支持思考块（extended thinking）重放、Prompt 缓存、中途断流重试（mid-stream retry）、流看门狗（stream watchdog）与最大输出截断恢复。
- **编排内核（OrchestrationKernel）** — 主聊天始终经由内核驱动：策略引擎（PolicyEngine PEP）、工具运行时（调度 / 流水线 / 配额 / 跨 Agent 历史）、检查点与暂停/恢复、重复与停滞守卫（repetition / stall guard）、重试策略、可观测性遥测。
- **三种交互模式** — Agent（全部工具 + 权限控制）、Plan（只读 + 写操作审批 + ExitPlanMode）、Ask（纯对话）。
- **人在回路（Durable HITL）** — 基于 Inbox 的持久化审批通道，进程重启后仍可恢复待确认的工具调用（可通过特性开关回退到内存态）。

### 智能体与协作
- **子智能体系统** — 内置 General-Purpose / Explore / Plan / Debug / Coordinator / Session-Memory 等 Agent，支持自定义 Agent（Markdown + YAML frontmatter 或 JSON）。Fork 子智能体继承父对话上下文与 System Prompt。
- **多智能体编排** — 父/子内核 parent→children 边追踪、并发上限、`interrupt / pause / resume` 级联，子智能体可绑定 Git Worktree 实现写隔离。
- **进程内团队（Teammate / Team）** — 团队成员邮箱（mailbox / inbox）、共享文件、团队记忆同步。
- **Swarm / Cron / 远程触发** — Swarm 多路复用、Cron 定时任务调度（独立 worker）、Remote Trigger 远程触发服务。
- **后台任务（V2 Task）** — TaskCreate/Get/Update/Stop/List + TaskOutput 全生命周期追踪，含「运行中智能体」监控面板。

### 代码智能与上下文
- **LSP 代码智能** — 集成 Language Server Protocol（pyright / typescript-language-server / vscode-langservers-extracted），提供跳转定义、查找引用、Hover、符号搜索、调用层级；无服务器时回退正则启发式。
- **MCP 协议** — 动态发现并执行 MCP 服务器工具（Stdio / SSE），统一注册到工具表，支持 MCP 资源读取。
- **本地向量检索（RAG）** — ONNX Runtime + Transformers.js，bge-m3 本地嵌入模型，工作区代码向量索引 + 词法/向量/附件 800ms 竞速检索增强上下文。
- **上下文管理** — 多级阈值检测（警告 → 错误 → micro-compact → auto-compact → 强制压缩），LLM 自动摘要替代旧消息；多遍消息规范化管线确保 `tool_use ↔ tool_result` 配对与 thinking 块位置正确。
- **记忆系统** — 四类记忆（user / feedback / project / reference），关键词召回 + BM25 + RRF 融合排序，对话后 LLM 自动提取长期记忆。
- **会话记忆** — 按工作区隔离的会话笔记，后台 Session-Memory 子智能体自动提取结构化笔记并持久化。
- **对话持久化** — 按工作区分区的 JSON 存储，自动保存 / 加载 / 全文搜索 / Markdown 导出。

### 编辑器与外设
- **Monaco Editor** — 多标签页、语法高亮、并行 Diff 视图、内联 Diff 装饰。
- **DiffTransaction 事务** — WAL 预写日志、原子写入、撤销队列、过期监听、审计面板，保证 AI 批量改文件可回滚。
- **Tab 自动补全** — FIM / chat 模式的内联补全后端。
- **内置终端** — node-pty + xterm 6，支持后台任务与 PTY 隔离。
- **附件管线** — 图片 / PDF / Office（docx/xlsx）/ 文本 摄取、缓存与预览。
- **Skills 技能系统** — 内置 + 项目级 / 用户级自定义技能（SKILL.md），含技能自动发现与字符预算控制。
- **插件市场** — MCPB 插件包安装、市场浏览与插件策略管控。
- **虚拟宠物伴伴（Buddy）** — 桌面伴随精灵，状态机 + Prompt 注入。
- **遥测** — 上下文事件、提供商错误环形缓冲、保留率（keep-rate）NDJSON 记录。

---

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（Vite HMR + Electron 热重载）
npm run electron:dev

# 仅构建渲染进程 + 主进程 + 微信 adapter（产物在 dist/ 与 dist-electron/）
npm run build

# 完整打包安装包（清理 → 安装 bundled LSP → 构建 → electron-builder，产物在 release/）
npm run electron:build

# 类型检查（等价于 tsc -b，切勿直接运行裸 tsc）
npm run typecheck

# 单元测试（Vitest）
npm test
# 或运行单个文件
npx vitest run electron/tools/fileToolValidation.test.ts

# E2E（Playwright Electron 模式，会弹出真实窗口）
npm run test:e2e

# Lint
npm run lint
```

> 环境要求：Node ≥ 20。本仓库使用 TypeScript **Project References**，根 `tsconfig.json` 仅作 solution 调度器，因此必须用 `tsc -b`（`npm run typecheck`）而非裸 `tsc`，否则会产生大量伪报错。

---

## 系统架构总览

```
┌──────────────────────────────────────────────────────────────────┐
│ Renderer (React 19 + Zustand 5 + Monaco)                           │
│  AIChat / Editor / Terminal / Sidebar / Settings / Workbench       │
│  RunningAgents / Composer / DiffAudit / Buddy / H5ConnectScreen    │
└───────────────▲───────────────────────────────────┬───────────────┘
                │ contextBridge (preload, 多域 API)   │ IPC 流事件
                │                                     ▼
┌───────────────┴───────────────────────────────────────────────────┐
│ Electron Main (Node.js)                                            │
│                                                                    │
│  ┌── ai/ ──────────── 多提供商客户端 + Agentic Loop + System Prompt│
│  ┌── orchestration/ ─ OrchestrationKernel + PolicyEngine          │
│  │                     + toolRuntime + HITL + multiAgent           │
│  ┌── tools/ ───────── 工具注册表 + Task/Team/Cron/Swarm/LSP/...    │
│  ┌── agents/ ──────── 内置/自定义 Agent + Fork + Bundle 注册表     │
│  ┌── lsp/ mcp/ ────── 语言服务器 + MCP 客户端/注册                 │
│  ┌── embedding/ ───── ONNX 本地嵌入 + 向量库 + 工作区索引         │
│  ┌── context/ memory/ session/ conversation/ ── 上下文与记忆      │
│  ┌── diff/ ────────── DiffTransaction（WAL/撤销/审计）            │
│  ┌── h5/ ──────────── H5 Server + IM 桥接（微信/钉钉/TG/飞书）     │
│  ┌── security/ settings/ ipc/ lifecycle/ telemetry/ plugins/ ...  │
└────────────────────────────────────────────────────────────────────┘
                │ 工具隔离（utilityProcess / worker_threads）
                ▼
┌────────────────────────────────────────────────────────────────────┐
│ 外设：bundled-lsp/（语言服务器）· resources/embeddings/bge-m3       │
│       adapters/（IM 运行时，Bun）                                    │
└────────────────────────────────────────────────────────────────────┘
```

---

## 项目结构

```
.
├── src/                              # 渲染进程（React + Zustand）
│   ├── components/
│   │   ├── AIChat/                   # AI 聊天面板（消息渲染/输入/虚拟滚动/工具卡片/子智能体块）
│   │   ├── Editor/                   # Monaco 编辑器（主编辑区/标签栏/Diff/内联 Diff/Office 预览）
│   │   ├── Workbench/                # Agent / Team / Bundle 编辑器（模态层）
│   │   ├── Settings/                 # 设置面板（Agents/MCP/Skills/Tools/Rules/Memory/LSP/Embedding/Storage）
│   │   ├── RunningAgents/            # 运行中智能体监控（列表 / 大屏 Fleet 视图 / 详情抽屉）
│   │   ├── Sidebar/                  # 文件树 / 搜索 / Git
│   │   ├── ActivityBar/              # 左侧活动栏
│   │   ├── TitleBar/ StatusBar/      # 自定义标题栏 / 底部状态栏
│   │   ├── CommandPalette/           # 命令面板（Ctrl+K）
│   │   ├── Terminal/                 # xterm 终端 + 输出 + 问题面板
│   │   ├── Composer/                 # 多步任务编排面板
│   │   ├── DiffToast/ DiffAudit/     # Diff 撤销提示 / DiffTransaction 审计面板
│   │   ├── BundleGallery/            # Bundle 画廊
│   │   ├── Buddy/                    # 虚拟宠物伴伴
│   │   ├── H5/                       # H5 远程接入连接屏（扫码 / 配对）
│   │   ├── Layout/                   # 工作区布局 / Markdown 预览 / 大纲侧栏
│   │   └── common/                   # 通用组件（虚拟列表 / Hook 编辑器等）
│   ├── stores/                       # Zustand 状态管理
│   │   ├── useChatStore.ts           # 聊天状态（5 个 slice 组合）
│   │   ├── chat/                     # slices + 主/子流路由 + 会话缓冲 + API 消息构建 + 竞速检索
│   │   ├── settings/                 # 设置 slice 组合
│   │   ├── useDiffTransactionStore.ts# Diff 事务状态（+ 权威同步）
│   │   ├── useLayoutStore / useFileStore / useFileTreeUIStore
│   │   ├── useWorkspaceStore / useWorkspaceIndexStore
│   │   ├── useDiagnosticStore / useOutputStore / useMemoryStore
│   │   ├── useTaskListV2 / executionStore / useToolRegistry
│   │   ├── bundleStore / capabilityCatalogStore / workbenchDraftStore
│   │   └── useBuddyStore / useUndoToastStore
│   ├── services/                     # 服务层（electronAPI / 文件系统 / 上下文构建 / 对话 / 记忆 / Agent / Diff / 权限 / 进程内工具）
│   ├── hooks/                        # useAgentExecution / useTeammateManagement 等
│   └── types/                        # TypeScript 类型（tool / Agent / ids）
│
├── electron/                         # 主进程（Node.js）
│   ├── main.ts                       # 入口（窗口、IPC 注册、生命周期）
│   ├── preload.ts                    # contextBridge 安全暴露 API（多域 build*Api 组合）
│   ├── ai/                           # AI 核心（多提供商客户端 / Agentic Loop / System Prompt / 权限规则 / 提供商适配）
│   │   ├── client.ts compatibleClient.ts zhipuToolGateway.ts
│   │   ├── agenticLoop*.ts agenticLoop/    # 工具循环引擎与子模块
│   │   ├── systemPrompt*.ts promptSections/ # System Prompt 构建与分层
│   │   ├── providers/ transformer/         # 各提供商流实现与消息转换
│   │   ├── tools.ts advancedTools.ts toolReadFile/Grep/Glob/...  # 文件与高级工具实现
│   │   ├── streamHandler*.ts streamWatchdog.ts streamWithMidStreamRetry.ts
│   │   └── permission*.ts interactionState.ts            # 权限规则 / 交互模式
│   ├── orchestration/                # 编排内核
│   │   ├── kernel.ts runOrchestratedSession.ts          # OrchestrationKernel + 会话驱动
│   │   ├── toolRuntime/              # PolicyEngine + 调度器 + 工具流水线 + 配额 + 跨 Agent 历史
│   │   ├── phases/                   # PrepareContext / CallModel / Terminal 阶段
│   │   ├── multiAgent.ts worktreeAllocator.ts           # 父/子内核 + Worktree 分配
│   │   ├── hitl.ts inbox*.ts         # 人在回路 + 持久化收件箱
│   │   ├── checkpoint.ts pauseResume.ts                 # 检查点 / 暂停恢复
│   │   ├── repetitionGuard / iterationStallGuard / retryPolicy
│   │   ├── channels.ts artifact.ts inbox.ts             # 通道 / 工件 / 邮箱
│   │   └── *.md                      # FEATURE_FLAGS / INVARIANTS / STREAM_SINKS / 迁移文档
│   ├── agents/                       # 子智能体系统（内置/自定义 Agent、Fork、Bundle 注册表、并发上下文）
│   ├── tools/                        # 工具系统（注册表 / Schema / Task / Team / Cron / Swarm / LSP / Notebook / 权限闸门 / worker 隔离）
│   │   ├── bash/ powershell/ office/ hooks/ tasks/ workerProcess/
│   │   └── 各 *Tool.ts               # 见「工具系统」一节
│   ├── lsp/                          # LSP 集成（管理器 / JSON-RPC 客户端 / 多语言服务器生命周期 / 预热）
│   ├── mcp/                          # MCP 集成（连接管理 / 工具与资源桥接）
│   ├── embedding/                    # ONNX 本地嵌入 + 向量库 + 工作区索引 + 模型下载
│   ├── indexing/                     # IndexerManager（索引取消 / 状态）
│   ├── diagnostics/                  # DiagnosticsHub（LSP + Monaco markers）
│   ├── context/                      # 上下文窗口管理 / compact / 消息规范化管线
│   ├── memory/                       # 持久化记忆（CRUD / 召回 / 自动提取）
│   ├── session/                      # 会话追踪 + 会话记忆提取 fork
│   ├── conversation/                 # 对话持久化（按工作区哈希分区）
│   ├── diff/                         # DiffTransaction（WAL / 原子写 / 撤销队列 / 过期监听 / IPC / 审计）
│   ├── attachments/                  # 图片 / PDF / Office / 文本 摄取与缓存
│   ├── autocomplete/                 # Tab 补全后端（FIM / chat）
│   ├── skills/                       # SKILL.md 发现 / 注册 / 模型覆盖
│   ├── plugins/                      # MCPB 安装 + 市场 + 插件策略（builtin/ 内置插件）
│   ├── h5/                           # H5 Server + IM 桥接（微信/钉钉/Telegram/飞书 + 配对 + 限流 + 访问策略）
│   ├── bridge/                       # 会话 spawner / worker / 活动环 / 会话消息
│   ├── buddy/                        # 伴伴（companion / state / prompt / sprites）
│   ├── telemetry/                    # 上下文事件 + 错误环形缓冲 + keep-rate
│   ├── security/                     # 工作区信任 + 路径沙箱 + 工具/MCP/终端策略 + 不可信文本清洗
│   ├── settings/                     # 磁盘设置存储 + 静态加密（secrets-at-rest）
│   ├── ipc/                          # 聚合 IPC + Zod validatedHandle + 输入清洗 + schemas
│   ├── lifecycle/                    # appBootstrap（whenReady 编排）+ appShutdown
│   ├── events/                       # EventDrivenNetwork（TaskManager → 生命周期事件总线）
│   ├── planning/                     # 计划运行时 + 计划校验状态
│   ├── window/ fs/ git/ terminal/    # 单窗口生命周期 / 渲染侧 FS / Git / PTY（沙箱闸门）
│   ├── watchers/ memdir/ paths/      # 文件监听 / 记忆目录 / 数据根与缓存健康
│   ├── logging/ constants/ utils/    # 日志镜像 / 常量 / 工具函数
│   └── rendererPrefs/ services/ integration/ testHelpers/
│
├── adapters/                         # IM Adapter 运行时（Bun）：微信 / 钉钉 / Telegram / 飞书
├── bundled-lsp/node_modules/         # 随包发布的语言服务器
├── resources/embeddings/bge-m3/      # 本地 ONNX 嵌入模型（model.onnx + tokenizer + config）
├── electron/agents/bundles/presets/  # Bundle 预设（code-dev / general-assistant / writing-assistant）
├── electron/plugins/builtin/         # 随包内置插件
├── scripts/                          # 构建脚本（buildWechatAdapter / E2E / 图标 / 主题重构等）
├── docs/                             # 设计文档与计划
├── electron-builder.json             # 打包配置（NSIS / DMG / AppImage）
├── vite.config.ts                    # Vite + vite-plugin-electron + Rolldown
├── tsconfig*.json                    # TypeScript Project References
└── package.json
```

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 框架 | Electron 41 |
| 前端 | React 19, TypeScript 5.9 |
| 构建 | Vite 8, vite-plugin-electron, Rolldown, esbuild |
| 状态 | Zustand 5 |
| 编辑器 | Monaco Editor 0.53, @monaco-editor/react |
| 终端 | xterm 6, node-pty |
| AI SDK | @anthropic-ai/sdk, openai, @google/generative-ai |
| 云端 AI | @anthropic-ai/bedrock-sdk / vertex-sdk / foundry-sdk / sandbox-runtime |
| MCP | @modelcontextprotocol/sdk 1.29 |
| LSP | vscode-languageserver-protocol, vscode-jsonrpc, vscode-languageserver-types |
| 向量 | @huggingface/transformers, onnxruntime-node（bge-m3） |
| 文档处理 | pdfjs-dist, mammoth, docx, exceljs, xlsx, docx-preview, turndown |
| 图像 | sharp, @napi-rs/canvas, qrcode |
| Git | simple-git |
| 校验 | zod 4 |
| UI 渲染 | lucide-react, react-markdown, remark-gfm, rehype-raw, react-window, mermaid |
| 编码/文件 | iconv-lite, chardet, chokidar, ignore, adm-zip, lru-cache, yaml |
| 测试 | Vitest 4, Playwright（Electron 模式） |
| IM Adapter | Bun（adapters/，grammy / 飞书 SDK / 微信 iLink / 钉钉 Stream） |

---

## 核心架构详解

### 1. 多提供商统一客户端

`electron/ai/client.ts`（配合 `compatibleClient.ts`、`zhipuToolGateway.ts`）封装多种 AI 提供商的流式调用，对外暴露统一接口。每种提供商内部处理工具 Schema 与消息格式的双向转换（Anthropic `tool_use` ↔ OpenAI `function_calling` ↔ Gemini `functionDeclarations`），并处理扩展思考、Prompt 缓存、Beta header、token 计数等提供商「怪癖」。提供商选择由 `ProviderConfig` 驱动，支持自定义 `baseUrl`。

### 2. Agentic Loop

`electron/ai/agenticLoop.ts`（façade）+ `agenticLoop/` 子模块构成工具调用循环：

```
用户消息 → API 流式调用 → 文本/思考增量输出
                          ↓
                    tool_use 块？
                    ├─ 是 → 权限/策略校验 → 执行工具 → tool_result 注入 → 重新调用
                    └─ 否 → 纯文本响应 → 结束
```

- 每轮评估上下文窗口，超阈值自动压缩；
- 内置中途断流重试、流看门狗、最大输出截断恢复、重复/停滞守卫；
- Plan 模式限制只读工具并对写操作走审批。

### 3. 编排内核（OrchestrationKernel）

主聊天始终经由 `electron/orchestration/kernel.ts` 驱动（旧的特性开关已默认硬开），围绕 Agentic Loop 提供：

- **PolicyEngine（PEP）** — 统一的策略评估点，聚合权限规则、chat-mode 约束、工作区信任；
- **toolRuntime** — 工具调度器、执行流水线、配额、跨 Agent 历史与状态追踪；
- **阶段拆分** — `phases/` 下的 PrepareContext / CallModel / Terminal；
- **HITL（人在回路）** — `hitl.ts` + Inbox 持久化审批，进程重启可恢复（`POLE_ORCHESTRATION_DURABLE_HITL`）；
- **检查点 / 暂停恢复** — `checkpoint.ts` + `pauseResume.ts`；
- **守卫与重试** — 重复守卫、迭代停滞守卫、重试策略；
- **可观测性** — `kernelTelemetry.ts` + AppendixA 阶段遥测（`POLE_APPENDIX_A_FLOW`）。

特性开关详见 `electron/orchestration/FEATURE_FLAGS.md`，不变量详见 `INVARIANTS.md`。

### 4. 多智能体编排

`electron/orchestration/multiAgent.ts`：父内核拥有顶层对话，`Agent` 工具创建子内核。编排器追踪 parent→children 边、强制并发上限，并把 `interrupt / pause / resume` 从父级级联到子级。子内核可绑定 Git Worktree（通过 `WorktreeAllocator`）实现与父工作区的写隔离；旧式子智能体通过 `CancellableKernelLike` 薄垫片参与级联。

### 5. 三种交互模式

| 模式 | 工具 | 权限 | 场景 |
|------|------|------|------|
| Agent | 全部 | 按需确认 / 策略放行 | 日常开发 |
| Plan | 只读 + ExitPlanMode | 写操作审批 | 复杂规划 |
| Ask | 无 | 无 | 快速问答 |

### 6. 工具系统

`electron/tools/registry.ts` 维护单例 `ToolRegistry`，支持注册/注销/列表/按只读筛选，带单调递增 `toolsetRevision` 变更检测；`schema.ts` 将会话级缓存的工具定义转换为各提供商 API 格式。工具可运行在两种进程：

- `runIn: 'main'`（默认）— 在主进程执行，直接访问文件锁、写完整性闸门、权限管理、MCP 传输；
- `runIn: 'worker'` — 转发到隔离 `utilityProcess`（打包默认开，开发默认关，可用 `ASTRA_TOOL_WORKER=1` 强制开）。

子智能体 worker（`electron/agents/subAgentWorker.ts`）则在 `worker_threads` 内联执行工具，与主进程共享同一份执行体实现。

### 7. 上下文管理

`electron/context/manager.ts` 的多级阈值系统在每轮评估 token 用量，依次触发 警告 → 错误 → micro-compact（截断旧 `tool_result`）→ auto-compact（LLM 摘要）→ 强制压缩。消息规范化管线（`normalizeMessagesForAPI`）执行多遍处理，确保 `tool_use ↔ tool_result` 配对、thinking 块位置正确（含 Anthropic thinking 签名在模型切换时的剥离）。

### 8. 记忆与会话

- **记忆系统** — 四类（user / feedback / project / reference），YAML frontmatter 文件存储，关键词召回 + BM25 + RRF 融合排序，对话后 LLM 自动提取并去重持久化；
- **会话笔记** — 会话结束后触发 Session-Memory 子智能体提取结构化笔记（目标 / 决策 / 文件 / 错误 / 学习），按工作区哈希隔离；
- **对话持久化** — JSON 文件按 Bundle / 工作区分区，支持自动保存、历史列表、全文搜索、Markdown 导出。

### 9. 流事件架构

渲染进程通过双层 IPC 监听器处理主进程流事件：

- **主聊天流路由器**（`mainStreamRouter.ts`）— 处理 20+ 事件类型（text_delta / thinking_delta / tool_start / tool_result / permission_request / context_compact / orchestration_phase 等），按 `conversationId` 路由到会话切片，增量批处理减少重渲染；
- **子智能体全局流路由器**（`subAgentStreamRouter.ts`）— 长生命周期监听 `subagent_*` 事件，按 `agentId` 路由；孤儿子智能体创建独立消息条目并按时序交叉渲染。

### 10. 渲染层架构

- **Zustand 5** 组合式 Store：`useChatStore` 由 5 个 slice 组合，多个独立 selector 避免全量订阅；
- **虚拟滚动**：`VirtualMessageList` 用高度缓存 + 二分查找处理数千条消息；
- **React 19 memo**：`ChatMessage` 通过自定义比较函数精确控制重渲染；
- **增量批处理**：流式 text/thinking delta 合并在 `requestAnimationFrame` 内投递。

### 11. DiffTransaction 事务

`electron/diff/` 为 AI 批量文件改动提供事务保证：WAL 预写日志（`diffTxWal`）、原子写入（`atomicWriter`）、状态机（`diffTransactionFsm`）、撤销队列（`undoQueue`）、过期监听（`diffTxWatcher`）、Hunk 选择与影子集成，并通过 `DiffAudit` 面板（`Ctrl+Shift+D`）审计。

---

## 工具系统

内置工具按域分组（部分工具按特性开关或 Agent 白名单按需加载）：

| 域 | 工具 |
|----|------|
| 文件 | `read_file` `write_file` `edit_file` `multi_edit_file` `list_files` |
| 检索 | `glob` `grep` `web_fetch` `WebSearch` |
| 终端 | `bash` `PowerShell` `REPL` |
| 智能体 | `Agent`（子智能体）`SpawnTeammate` `SwarmMultiplexer` |
| 任务 | `TaskCreate` `TaskGet` `TaskUpdate` `TaskStop` `TaskList` `TaskOutput` `KillAgentTasks` `KillAllTasks` |
| 团队 | `TeamCreate` `TeamDelete` `TeamMemorySync` |
| 计划 | `EnterPlanMode` `ExitPlanMode` `VerifyPlanExecution` |
| Worktree | `EnterWorktree` `ExitWorktree` |
| 代码智能 | `LSP` `ReadDiagnostics` `NotebookEdit` |
| 交互 | `AskUserQuestion` `TodoWrite` `SendUserMessage` `SendMessage` `PromptSuggestion` `AwaySummary` `Brief` |
| 发现 | `ToolSearch` `Skill` / `DiscoverSkills` `MagicDocs` `MemdirScan` |
| MCP | `ListMcpResources` `ReadMcpResource` + 动态 MCP 工具 |
| 调度 | `Cron`（定时任务）`RemoteTrigger`（远程触发） |
| 配置 | `Config` |

工具调用受权限闸门保护：路径沙箱（`pathSecurity`）、写前预检（`writeToolPreflightGate`）、写完整性闸门（`writeIntegrityGuard`）、文件锁（`fileLock`）、读后写约束（`readFileState`）、bash/PowerShell 命令安全策略。

---

## 远程接入（H5 + IM）

`electron/h5/` 内置一个本地 H5 Server，可让你在桌面之外通过浏览器或即时通讯软件远程驱动 Agent：

- **H5 网页接入** — 扫码 / 配对（`src/components/H5/H5ConnectScreen.tsx`），带访问策略（`h5AccessPolicy`）与限流（`h5RateLimit`）；
- **IM 桥接** — 微信、钉钉、Telegram、飞书。配置与配对在 桌面端 设置 → IM 接入，写入 `~/.claude/adapters.json`；
- **Adapter 运行时** — `adapters/`（基于 Bun），需手动启动对应进程：

```bash
cd adapters
bun install
bun run wechat      # 或 dingtalk / telegram / feishu
```

链路：`Desktop Settings → /api/adapters → ~/.claude/adapters.json → adapters/<platform> → /api/sessions + /ws/:sessionId → Agent 会话`。支持双向图片/文件附件（走统一 `AttachmentRef` 协议），落地到 `~/.claude/im-downloads/{platform}/{sessionId}/`，24 小时自动 GC，单图 ≤10 MB、单文件 ≤30 MB。详见 `adapters/README.md` 与 `docs/im/`。

---

## 安全模型

- **工作区信任** — `workspaceTrustMode`（设置 → 权限）：`legacy`（空信任表隐式信任并自动加入）或 `strict`（空信任表不信任任何工作区，渲染侧需走「信任此工作区」UX）。边界检查见 `electron/security/workspaceAccept.ts`，信任表存于 `<userData>/trusted-workspaces.json`；
- **路径沙箱** — 所有文件/终端工具受路径边界校验；
- **不可信文本清洗** — 外部内容（网页/IM/附件）经 `sanitizeUntrustedText` 处理，防 Prompt 注入；
- **策略管控** — 渲染侧工具策略、MCP 配置策略、终端执行策略、插件策略；
- **静态加密** — 设置中的密钥（secrets-at-rest）落盘加密；
- **权限预检失败默认 fail-closed**（`POLE_PREFLIGHT_FAIL_OPEN` 仅供调试，生产勿开）。

---

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+K` | 命令面板 |
| `Ctrl+B` | 切换侧边栏 |
| `Ctrl+J` | 切换终端 |
| `Ctrl+L` | 切换 AI 聊天 |
| `Ctrl+Shift+M` | 问题面板 |
| `Ctrl+Shift+D` | DiffTransaction 审计 |
| `F8` | 下一个诊断 |
| `Escape` | 关闭命令面板 |

---

## 开发指南

### 添加新工具
1. 在 `electron/ai/tools.ts` / `advancedTools.ts`（或独立 `*Tool.ts`）实现，标注 `runIn`；
2. 在 `electron/tools/registry.ts` 注册（必要时加入对应 Agent 白名单 `electron/agents/builtInAgents.ts`）；
3. Schema 经 `electron/tools/schema.ts` 自动转换为各提供商格式。

### 添加新 AI 提供商
1. 在 `electron/ai/client.ts` 增加 `stream*` 函数并实现消息格式双向转换；
2. 在 `PROVIDERS` 与 `getModelsForProvider()` 注册；
3. 前端 `src/stores/settings/` 同步模型列表。

### 添加新内置 Agent
在 `electron/agents/builtInAgents.ts` 定义 Agent（System Prompt + 工具白名单 + 权限模式 + `maxTurns`），自动注册到 `Agent` 工具。

### 添加新技能
在 `electron/skills/bundledSkills.ts` 添加，或在 `{workspace}/.cursor/skills/` 或 `{workspace}/.claude/skills/` 创建 `SKILL.md`。

> 更多约定（为何 `tsc` 必须用 `-b`、工具进程模型、E2E 注入钩子、打包清单等）见仓库根目录的 `AGENTS.md`。

---

## 测试

```bash
npm test                                   # 全部单元测试（Vitest）
npx vitest run path/to/foo.test.ts         # 单个文件
npx vitest run electron/agents             # 某目录
npm run test:e2e                           # E2E（Playwright Electron 模式，弹真实窗口）
npm run test:e2e -- -g "U-01"              # 过滤 E2E 用例
```

E2E 通过 `VITE_E2E_HOOKS=1` 注入 `window.__e2eInject*` 钩子（生产/开发构建不携带），首个用例会按 `Ctrl+L` 打开聊天面板。

---

## 打包发布

`npm run electron:build` 会依次执行：清理 → 安装 bundled LSP → `vite build` → 构建微信 adapter → `electron-builder`。打包前确保：

1. `bundled-lsp/node_modules/` 存在（`npm run bundled-lsp:install`）；
2. `resources/embeddings/bge-m3/` 含 `model.onnx`（~570 MB）+ `tokenizer.json` + `config.json`；
3. 所有源文件为合法 UTF-8（Rolldown 会拒绝混合编码）。

产物（Windows NSIS / macOS DMG / Linux AppImage）输出到 `release/`。

---

## 许可证

MIT
