# AI Chat 平滑度审计报告（第二轮 · 系统性 + 细颗粒度）

> 生成时间: 2026-06-16

---

## 实施后复审（§2.1 / §2.2 / §3.1 三阶段改动 · 2026-06-16）

> 方法: 4 个并行只读子智能体分别审计 阶段一(流式 Markdown)/阶段二(tool_input 批处理)/阶段三(memo 比较器) + 跨阶段集成,主智能体交叉验证。

**已修复的真实 bug(本轮):**

1. **🔴 `applyToolInputBatch` 缺终态守卫(两路审计交叉确认)** — `streamEvents/applyToolInputBatch.ts`。原实现缺少 `applyBatchedDeltas` 已有的"消息已结束则丢弃 straggler"守卫,导致 cancel / `tool_start` 之后,pending rAF 或迟到的 `tool_input_delta` 会写回 `streamingInput`,**复活已停止工具的 Write/Edit 进度卡/caret**。修复:加 `if (m.isStreaming === false) return m`(终态丢弃)+ 每工具 `if (t.streamingInput == null) return t`(`tool_start`/`tool_result`/stop 已清则不复活)+ `entry.assistantId === m.id`(精确目标)。新增 2 个回归测试(tool_start 后迟到 delta、finalize 后批处理写入)。
2. **🟠 流式 Markdown fence 状态机混用标记(阶段一审计)** — `chatMessage/markdown.tsx` `splitStreamingMarkdown`。原 `inFence = !inFence` 把任意 ```` ``` ````/`~~~` 行都当切换,导致 ```` ``` ```` 代码块内的 `~~~` 行误判"出栏",其后空行成为错误切分点(流式期把半截代码块当正文渲染,虽 message_stop 后自愈)。修复:跟踪开栏标记,仅同类标记闭栏。新增 `~~~` 围栏 + 混用标记 2 个测试。

**后续跟进(已完成 2026-06-16):**

- ✅ **blocks 路径结构化错误字段 plumbing** — 扩展 `ContentBlock.tool_use` 类型加 5 个结构化错误字段(`toolErrorClass/errorWhat/errorTried/errorContext/errorNext`),ChatMessage 三处 `toolUse`/`tools` 构造从 block 透传,`ToolBlockGroup.tools` 接口 + `toolBlockGroupPropsEqual` 同步加字段。现在 blocks 主路径也能显示结构化错误 headline/Tried/Next,不再降级为 flat error。
- ✅ **`ToolBlockGroup` 内层回调稳定化** — 子卡 `onStop/onRetry` 由内联 `()=>onStop(tool.id)` 改为直接透传组接收的稳定(模块级)`onStop/onRetry`,组重渲染时不再击穿每个子卡 memo,完成 memo 优化闭环。

**回归修复(2026-06-17,用户报告"第二次对话 UI 叠加到第一次上面"):**

- 🔴 **虚拟化行重叠 = ResizeObserver 漏观测首批行** — 此前把 `attachMeasureRef`(每渲染新建回调)改为稳定缓存 `getMeasureRef` 时引入时序 bug:RO 在 `useEffect`(commit 后)创建,而 ref 回调在 commit 期间运行,**首次 commit 挂载的可见行**执行 ref 回调时 `sharedObserverRef.current` 仍为 `null` → `observer?.observe()` 空操作 → 这些行永不被观测 → 挂载后内容增高(流式/异步 markdown/colorize)不更新 itemHeights → `position:absolute` 的虚拟行偏移基于陈旧行高 → **相互叠压**。旧实现每渲染重建回调,React 重新 attach,在 RO 创建后下一帧补上 observe,无此问题。修复(`VirtualMessageList.tsx`):RO 创建后遍历 `nodeToMessageRef` 对已挂载节点补 `observe` + 重测一次。注:非虚拟化路径为 flex 正常流,不会重叠,故该问题仅在已触发虚拟化的会话出现。

**性能技术债(已完成 2026-06-16):**

- ✅ **`subAgents` 整表重建牵连无关工具卡** — `ChatMessage.subAgentsByParent` 增加 per-parentToolId 数组引用复用缓存(`subAgentArrayCacheRef`):某个子代理更新时,成员未变的其它父工具桶复用旧数组引用,只有真正变化的工具卡重渲染。
- ✅ **`useTaskOutput` 订阅全量 `byId`** — `ToolUseCard` 改用 `useTaskOutputSlice(taskId)` 仅订阅本工具的 task 切片,其它工具的 bash/流输出变化不再触发本卡重渲染。

**进阶优化(已完成 2026-06-17):**

- ✅ **流式 Markdown 前缀 O(n²) → O(n)** — `splitStreamingMarkdown`(单前缀整段重解析)改为 `segmentStreamingMarkdown`(逐段):每个已完成段落是内容不可变的独立 memo 段,只解析一次;仅尾段每帧解析。
- ✅ **WriteEditProgressView 流式期 colorize 降级** — `HighlightedCode` 的 `monaco.editor.colorize` effect 用 `!streaming` 门控,流式期走纯文本(尾部裁剪 + caret),流式结束上色一次,消除每帧高亮开销。
- ✅ **ChatPanel `messages` 订阅下沉** — 抽出 `chatPanel/ChatMessageList`(内部订阅 `messages` + 承载滚动容器/虚拟化/跟底 effect/空状态,经 ref 暴露 `jumpToMessage`);ChatPanel 改订阅 `messages.length`。流式 delta 只重渲染 transcript 子树,不再重渲染面板 chrome 及其 O(n) 派生计算。滚动关键逻辑逐字迁移以保持已修复的跟底/防中间跳行为。

**进阶优化复审(2026-06-17,4 路子智能体):**

- 🔴 **已修复:`getState()` 快照导致弹窗在流式期间冻结** — 复审发现下沉时让 `ReasoningTimeline`/`HistorySearchDialog` 接收 `useChatStore.getState().messages` 快照,而这两者本设计为依赖**实时** messages(reasoning 时间线含 streaming 块、"当前会话"搜索消息正文)→ 流式中打开后不更新,属真实功能回归。修复:两者改为**内部 `useChatStore(s => s.messages)` 自订阅**,移除 messages prop 与 ChatPanel 的 getState 读取。
- ✅ **ChatMessageList 加 `React.memo`** — ChatPanel 自身定时器(spinner tip / context / planning 轮询 ~0.3Hz)原会连带 reconcile 列表子树;props 均为稳定引用 → memo 后跳过,#3 优化闭环。
- 核验通过:#1 分段 memo 经字符串值相等命中(O(n)),fence/round-trip 测试覆盖,仅可能产生无害空段;#2 colorize 在 streaming→done 恰好触发一次(工具卡 `AnimatedBlock` key 稳定不 remount);#3 三个滚动 effect/jumpToMessage/DOM 结构逐字等价,`countBackgroundActiveStreams` 返回稳定 number 不致 per-delta 重渲染。
- ✅ **已修复(既有遗留):`ChatMessage` 缺 `chat-message-${id}` DOM id** — 给三个渲染分支根节点(`chat-message user` / `chat-message assistant agent-only` / `chat-message assistant`)加上 `id={`chat-message-${message.id}`}`。此前非虚拟化(短会话)下 `jumpToMessage` 的 `getElementById` 分支为 no-op(点 reasoning/搜索结果不滚动),现可正确 `scrollIntoView`。(`compact_boundary` 为分隔符,非跳转目标,不加。)
- 复审后 `tsc -b` 通过,`AIChat + stores/chat + services` 共 **539 项测试全绿**。
- 🟡 流式 Markdown 跨边界结构(引用块/脚注/HTML)瞬态错乱 + 前缀越界 O(n²) 累计解析 + 边界 `p:last-child` 间距:均为流式期瞬态,`message_stop` 单实例解析自愈,属计划已接受的取舍。

**复审结论:** 三阶段主干设计 sound(首 delta 同步保序、非 delta 先 flush、latest-wins rAF、memo 比较器字段完整且 `errorWhy` 不存在、hook 顺序合规、`useTaskOutput` 不被 memo 冻结、持久化剥离 streamingInput);唯一确认的运行时真实 bug(终态守卫)已修。复审后 `tsc -b` 通过,`AIChat + stores/chat + services` 共 **538 项测试全绿**。

---

> 范围: AI chat 全链路平滑度 —— LLM token 流 → Electron 主进程 → IPC → 渲染进程 store → React 重渲染 → 富内容渲染 → 滚动/虚拟化 → 输入框/焦点
> 方法: 5 个并行只读探索子智能体分维度深扫 + 主智能体交叉验证
> 基线: 对照 `UI_DELAY_BUGS_REPORT.md`（2026-05-05 全项目报告）核验"已修复 / 仍存在 / 新发现"

---

## 0. 一句话结论

自上轮报告后，**架构层已显著改进**（三层 delta 节流、条件虚拟化、ChatMessage memo、焦点守卫、Mermaid/HTML 防抖均已落地）。当前残留的平滑度瓶颈高度集中在 **3 个"每帧全量重算"热点** 和 **1 个已确认的焦点守卫 bug**：

| # | 瓶颈 | 本质 | 多 agent 共识 |
|---|------|------|--------------|
| 🥇 | 流式 Markdown 全文重解析 | `showCursor` 时绕过 `useDeferredValue`，每帧（~60Hz）对整条消息全文跑 remark/rehype | 管线 / 富内容 / 渲染 三路一致命中 |
| 🥈 | `tool_input_delta` 渲染端无批处理 | 每个 IPC 一次 `messages.map` + 每帧 Monaco `colorize` | 管线 / 渲染 两路命中 |
| 🥉 | `ThinkingBlock` 100ms 定时器 | 不检查可见/折叠，每 100ms 触发全文 markdown 重解析 | 富内容 / 渲染 两路命中 |
| 🐞 | **焦点守卫 CSS 选择器写错（已确认 bug）** | `.chat-input-textarea` 应为 `.chat-input`，后备守卫永不生效 | 输入/焦点路 + 主智能体直接验证 |

---

## 1. 🐞 已确认 Bug：焦点守卫后备选择器失效（✅ 已修复 2026-06-16）

> 修复：`editorFocusGuard.ts` 用"最近聊天输入时间戳"（`noteChatInputActivity` + 700ms 窗口）替代失效的 `.chat-input-textarea` 选择器，并将该判断提到 `body` 提前 return **之前**（失焦场景正是焦点掉到 `body`）。`ChatInput.tsx` onChange 打点。新增 2 个回归测试，`editorFocusGuard.test.ts` 全 20 项通过。

**文件**: `src/services/editorFocusGuard.ts:72`
**证据**:
- `editorFocusGuard.ts:72` 查询 `document.querySelector('.chat-input-textarea')`
- `ChatInput.tsx:686` 聊天输入框实际 `className="chat-input"`
- 全代码库 grep：`.chat-input-textarea` **零匹配**（仅此一处引用，无对应元素）

**后果**: 该后备守卫（71-77 行）意图是"`activeElement` 已变成 `body` 但用户刚在聊天框输入时，阻止 Monaco 抢焦点"，但因选择器找不到元素而**永不触发**。当会话笔记子智能体渲染、tab 切换或 diff 挂载触发 `focusEditorIfIdle` 时，若此刻焦点恰好掉到 `body`（IME 假焦点常态），Monaco 仍会成功抢焦点 → 与用户历史报告的"会话笔记后输入框失焦约 20s"现象吻合。

**严重度**: 🔴（功能性 bug，非纯性能，且修复成本极低）
**修复方向**: 选择器改为 `.chat-input`（或 `textarea.chat-input`）；并把判据从"value 非空"升级为"`document.activeElement === textareaRef` 或最近 N ms 有 input 事件 + 时间戳"，避免输入框有残留文本时永久阻止编辑器获焦。

---

## 2. 🔴 P0 级流式热点

### 2.1 流式 Markdown 每帧全文重解析（最大 CPU 热点）（✅ 已修复 2026-06-16）

> 修复（`chatMessage/markdown.tsx`）：流式时改为"冻结前缀 + 实时尾段"增量解析。新增纯函数 `splitStreamingMarkdown`（fence 感知,只在代码围栏外的空行切分,`<2000` 字符或无安全边界则不切）将已完成段落冻结进 `memo` 化的 `FrozenMarkdown`(不再每 token 重解析),只有正在生长的小尾段每帧重解析;`message_stop` 后整段单次解析自愈。新增 `markdown.streaming.test.ts`(7 项边界矩阵)。

**文件**: `src/components/AIChat/chatMessage/markdown.tsx:72-74`、`ChatMessage.tsx:540`
**证据**: `const mdText = showCursor ? text : deferredText`，而 `showCursor = message.isStreaming`。即**正在流式的消息刻意绕过 `useDeferredValue`**，每帧用最新全文驱动 `ReactMarkdown`，触发完整 remark/rehype 管线（含 `rehype-raw` 内联 HTML 解析）。
**影响**: 长回复时随字符数线性恶化，是主聊天 prose 打字机卡顿的首要来源。
**修复方向**（任选其一/组合）:
- 流式期也用 deferred，仅尾部少量字符实时跟光标；
- 流式期降级为轻量 `<pre>`/纯文本，`message_stop` 后再 markdown；
- 按闭合 fence/段落做块级缓存，仅重 parse 尾部块。

### 2.2 `tool_input_delta` 渲染端无批处理 + 每帧 Monaco colorize（✅ 渲染端批处理已修复 2026-06-16）

> 修复:新增 `toolInputDeltaBatcher.ts`(latest-wins + rAF 合批)+ 桥接 `applyToolInputBatch.ts`。`mainStreamRouter` 首个 delta 仍同步种 placeholder(保序),后续同工具 delta 改走批处理 → ~20Hz/工具的每事件 `setState`+全量 `messages.map` 降为 ≤1/帧;非 delta 事件前 `flushPendingToolInputsNow` 保证顺序。新增 `toolInputDeltaBatcher.test.ts` + 扩展 `mainStreamRouter.toolInput.test.ts`。(WriteEditProgressView 每帧 Monaco colorize 的进一步降级仍可后续单独优化。)

**文件**: `mainStreamRouter.ts:143-147,487-535`、`streamingDeltaBatcher.ts`、`WriteEditProgressView.tsx:265-284,611-642,703`
**证据**:
- 主进程已把 tool input 节流到 ~20Hz/tool（`toolInputDeltaThrottle.ts:51`），但 `tool_input_delta` **不在** rAF batcher 白名单，渲染端每个 delta 独立 `setState` 且做整表 `messages.map`（O(n) 浅拷贝）。
- `WriteEditProgressView` 每次 render（~20Hz）做 `parsePartialWriteInput` 线性扫描 + Monaco `colorize`（注释明确刻意不 `useMemo`）。
**影响**: 大文件 Write/Edit 流式预览是第二卡顿场景；长会话 n 大时主线程周期性抖动。
**修复方向**: 将 `tool_input_delta` 纳入 rAF batcher（或专用 tool-input batcher），只 patch 目标 `toolUses` 条目；流式期纯文本 + caret，结束后再 colorize；partial 解析结果按 `partialJson.length` 缓存。

### 2.3 `ThinkingBlock` 100ms 定时器驱动全文重解析（✅ 已修复 2026-06-16）

> 修复：markdown 正文抽成 `React.memo` 子组件 `ThinkingMarkdownBody`，计时 tick 触发的父组件重渲染在 memo 边界处停止，不再每 100ms 重跑 `ReactMarkdown`；计时器按 `inView` 门控（离屏暂停 setState，带持久 `startAnchorRef` 锚点保证回屏时间准确；无 `IntersectionObserver` 环境保持原有不间断 tick 行为）；`remarkPlugins` 提为模块级常量。`tsc -b` 通过。

**文件**: `ThinkingBlock.tsx:398-409,541`
**证据**: `isStreaming` 时 `setInterval(..., 100)` 更新 `displayMs`，**不检查 `expanded` / `inView` / 折叠状态**；每次 tick 触发整组件重渲染 → 第 541 行全文 `ReactMarkdown` 再解析一遍（即使内容无变化）。结束后会 `clearInterval`（正向）。
**影响**: 长 reasoning 流时，与正文流叠加争抢主线程；折叠或滚出视口仍每秒 ~10 次全文重解析。
**修复方向**: 拆分"计时 header 子组件"与"markdown 子树"，tick 只更新 header；`inView && expanded` 时才 tick；流式期正文 `useDeferredValue` 或纯文本。

---

## 3. 🟠 P1 级渲染/订阅粒度问题

### 3.1 关键子树缺 `React.memo`（部分修复，仍有高危项）

| 组件 | 文件:行 | 状态 | 影响 |
|------|---------|------|------|
| `ToolUseCard` | `ToolUseCard.tsx:342` | ✅ 已修复 2026-06-16 | `memo` + 自定义逐字段比较器(`toolCardEquality.ts`);ChatMessage 侧 `subAgentsByParent` useMemo 化 + 模块级 `stopToolTaskById/retryToolTaskById` 稳定 props |
| `ToolBlockGroup` | `ToolBlockGroup.tsx:139` | ✅ 已修复 2026-06-16 | `memo` + `toolBlockGroupPropsEqual`(tools 逐元素比较) |
| `AgentBlock` | `AgentBlock.tsx:203` | 🔴 仍缺 | 嵌套 ToolUseCard 列表 + 滚动 effect |
| `ThinkingBlock` | `ThinkingBlock.tsx:337` | 🔴 仍缺 | 见 2.3 |
| `MarkdownContent` | `markdown.tsx:72` | 🟠 仍缺 | 随父级每帧重跑 |
| `CodeBlock`/`MermaidBlock`/`HtmlPreviewBlock`/`ImagePreview` | 各文件 | 🟠 仍缺 | 父级 markdown 重渲染连带 |
| `SubAgentsProgressBar` | `SubAgentsProgressBar.tsx:39` | 🟠 仍缺 | 多 sub-agent 流式 stats 重算 |
| `ChatMessage` / `ActivityRow` / `CommandChip` / `ChatInput` | — | ✅ 已加 | 历史消息/工具行/输入框已隔离 |

**新发现（重要）**: `ActivityRow` 虽已 memo，但 `ToolUseCard.tsx:460-469`、`AgentBlock.tsx:289-403` 向它传**内联 `children` JSX**，浅比较 children 引用每帧变化 → **带 details 的行 memo 名存实亡**。修 memo 时需同步把 children 提成稳定子组件。

### 3.2 `ChatPanel` 订阅整个 `messages` 数组 → 每帧整面板重渲染

**文件**: `ChatPanel.tsx:62,276-278,419-449,665-697`
**证据**: `useChatStore((s) => s.messages)`；每帧 batched flush 产生新 `messages` 引用 → ChatPanel 整组件重渲染（header / TodoPanel / StreamingBar 等连带 reconcile，ChatInput 因 memo 可跳过）。`applyBatchedDeltas.ts:128` 数组引用每帧必变，memo 能挡叶子组件但挡不住数组级订阅者。
**修复方向**: 把 `messages` 订阅下沉到 `MessageList` 子树；Panel 只订阅 `messages.length` + streaming message id + streaming 标志。

> **✅ 已修复 2026-06-16（AgentBlock）**：`AgentBlock` 加 `React.memo`。已验证 `applyBatchedDeltas` 用 `{ ...m, content, blocks }` 展开，主文本流式时 `subAgents` 引用稳定，故 `agent` prop 在主流式期间不变 → 跳过子代理子树重渲染；子代理自身流式时其条目换新对象 → 正常更新。
> **⏭ ToolUseCard/ToolBlockGroup 暂缓**：二者收到的是每渲染新建的内联 `toolUse={{...}}` + 每渲染重建的 `subAgents` Map + 内联 `onStop/onRetry`，直接加默认 memo 零收益（toolUse 引用必变）。要见效须先 `useMemo` 稳定 `subAgentsByParent`、模块级稳定 `onStop/onRetry`、并写自定义比较器（含 streamingProgress/streamingInput 等流式字段）——属有回归风险的专门优化，留待单独处理，不在"修真实 bug"范围内。

### 3.3 内联回调/对象 props 破坏 memo

**文件**: `ChatMessage.tsx:359-360,380-381,486-487`（inline `onStop`/`toolUse={{...}}`）、`ConversationList.tsx:395,552`（`renderRow` 非 `useCallback`）、`VirtualMessageList.tsx:272-297`（每 render 新建 `attachMeasureRef` → ResizeObserver 解绑/重绑抖动）
**修复方向**: 提取模块级 stable handler 或 `useCallback`；`attachMeasureRef` 用 `useCallback` 工厂或 ref map。

> **✅ 已修复 2026-06-16（attachMeasureRef）**：改为 per-id 缓存的稳定 ref 回调（`measureRefCacheRef`），React 仅在真实挂载/卸载时调用，消除流式期每帧对每个可见行的 `getBoundingClientRect()` 强制重排 + RO unobserve/observe 抖动；stale 清理时同步删除缓存项防止无界增长。`ConversationList.renderRow` 仍待办。

### 3.4 子代理流渲染端无 batcher

**文件**: `subAgentStreamRouter.ts:356-433,712-763`
**证据**: 主进程 IPC 已把 subagent 文本合并到 ≤60Hz（`streamCoalescer.ts:38-42`），但渲染端 `subagent_text` / `subagent_thinking_delta` / `subagent_tool_input_delta` 仍每 IPC 一次 `setState` + 父 assistant 行 `messages.map`。叠加 `AgentBlock` 无 memo → 多子代理并行时父 `ChatMessage` 高频重渲染。
**修复方向**: 子代理复用 `streamingDeltaBatcher`（按 agentId 分桶）+ `AgentBlock` 加 memo。

---

## 4. 🟠 滚动与虚拟化

| 项 | 文件:行 | 状态 | 说明 |
|----|---------|------|------|
| VirtualMessageList scroll 节流 | `VirtualMessageList.tsx:91-102` | ✅ 已修复 | rAF 合批 + passive |
| 条件虚拟化 | `ChatPanel.tsx:281-283`、`chatRenderableWeight.ts:69-75` | ✅ 已修复 | >40 条或 ≥50k 字符启用 |
| `staticLayout` O(n) 重建 | `VirtualMessageList.tsx:170-188` | 🟠 仍存在 | 依赖 `[messages]`，流式每 delta 换引用 → 长会话每 token 全表重算 offsets（scroll 本身已 O(log n)） |
| **流式跟底落在中间(用户报告)** | `VirtualMessageList.tsx:213,268`（pin / scrollToBottom 用估算 `totalHeight`） | ✅ **已修复 2026-06-16** | **真实 bug**：跟随用估算 `totalHeight-ch` 作底部目标，而 `onScroll`(`ChatPanel.tsx:347`)用**真实 `scrollHeight`** 判 `isNearBottom`——二者不一致 → 流式时把用户拽到"估算底部=真实中部",用户往下滚接近真实底又被下个 delta 拽回，形成"卡在中间、到不了底、停了才能到底"的死循环。**改为 pin/scrollToBottom 都用容器真实 `scrollHeight`**，与判定端一致。最坏等价原值(+padding)，无回归 |
| 流式跟底双通道 | `ChatPanel.tsx:425-431` + `VirtualMessageList.tsx:195-203` | 🟠 仍存在 | 同一 delta 可能 ChatPanel effect 与 layoutEffect 两次 pin-bottom，读 `scrollHeight` 触发布局（现两端目标已统一，影响降低） |
| ChatPanel `onScroll` 无 rAF | `ChatPanel.tsx:346-354` | 🟡 仍存在 | 每次 scroll `setIsNearBottom`（值相同时 React bail out，仍多一次调度） |
| RO 高度更新无 rAF 合批 | `VirtualMessageList.tsx:60-79` | 🟠 仍存在 | 多行同时测量可能连触发多次 render（对比 `SimpleVirtualList` 已 rAF 合批） |
| `ThinkingBlock` 块内无 near-bottom 检测 | `ThinkingBlock.tsx:472-477` | 🟡 仍存在 | 用户上滚读历史 reasoning 会被拉回底（仅块内） |

**修复方向**: `staticLayout` 增量维护 prefix-sum（仅末行高度变时从 `lastIndex` 重算）；流式跟底合并为单一路径（仅 layoutEffect 或仅 rAF scroll）；ChatPanel `onScroll` 改 ref-first + rAF；RO 更新对齐 SimpleVirtualList 的 rAF 合批。

---

## 5. 🟠 输入框与焦点（除 §1 已确认 bug 外）

### 已验证修复
- `focusTextareaSoon` 改 rAF（`ChatInput.tsx:104-111`）
- `editorFocusGuard` 主路径生效（tab 切换/diff 挂载/pendingJump 均 guarded）
- Monaco 挂载不再抢焦点（`EditorArea.tsx:360-386`）
- ChatInput 与流式解耦（字段 selector + `React.memo` + batcher）→ 历史"每 token 重渲染致 IME 脱落"已封堵
- textarea auto-resize 改 rAF 异步测量（`ChatInput.tsx:131-142`）
- 检索阻塞 capped 800ms（`retrievalBudget.ts:40`）；危险模式确认改 React Portal（消除一类中文 IME 假死）

### 仍存在 / 新发现
| # | 项 | 文件:行 | 严重度 | 说明 |
|---|----|---------|--------|------|
| 5.1 | `editor:action` 未守卫的 `editor.focus()` | `EditorArea.tsx:495` | ⏭ 经核验非 bug | 该 focus 是 undo/redo 经 `editor.trigger` 路由的**功能前置**（见行内注释），且仅由用户主动触发编辑器动作时分发，聚焦编辑器即预期行为；加守卫反而可能破坏动作路由，故不改 |
| 5.2 | 无 IME `composition` 护栏 | 全 AIChat 无 `onCompositionStart/End` | 🟠 | 受控 `value={inputText}` 每键写 store；组词期遇突发重渲染/layout 仍可能选字中断 → composition 期写本地 state，end 后再同步 |
| 5.3 | 发送后多帧抖动 | `sendSlice.ts:212-240,338`、`ChatPanel.tsx:419-449`、`apiMessageBuilder.ts:39-111` | 🟠 | "3-5 次卡顿"部分消除；残留：滚底双 rAF + 编排相位致 ChatInput 额外 2-3 次重渲染 + 800ms 后**同步** `buildMainChatApiMessagesForSend`（读活动文件前 100 行/全 tabs/诊断/全量 messages 转换 + 2 次 localStorage 读）→ 异步化/`requestIdleCallback` |
| 5.4 | `SkillPopup` 大列表 O(n) 无缓存 | `SkillPopup.tsx:51-54` | ✅ 已修复 | 已 `useMemo([skills, query])`，并使 `filtered` 引用稳定（减少 keydown 监听 effect 重绑） |
| 5.5 | `setTimeout` vs rAF 焦点竞争（编辑器侧） | `EditorArea.tsx:475`、`InlineEditController.tsx:47,149` | 🟡 | ChatInput 已统一 rAF，编辑器侧仍有 50-60ms timer → 可引入单一 FocusCoordinator |
| 5.6 | 每键同步写 store 无节流 | `ChatInput.tsx:695`、`inputSlice.ts:42` | 🟡 | 已隔离流式，一般可接受；长会话+弹窗叠加 useMemo 时有可感知延迟 → 本地草稿 state / `startTransition` |

---

## 6. 富内容渲染（详见 §2.1 / §2.3 外的其余）

| 项 | 文件:行 | 状态 | 说明 |
|----|---------|------|------|
| 代码块语法高亮 | `CodeBlock.tsx:35-37` | 🟢 无高亮库 | 纯 `<pre><code>`，零高亮 CPU（性能利好）；流式时仍每帧重渲染文本节点（🟡），未来若加高亮务必 debounce + Worker |
| Mermaid | `MermaidBlock.tsx:117-122` | 🟢 250ms debounce | 未完成图表周期性 parse（多数失败被 `suppressErrors` 抑制），不每 token；可流结束再 render |
| HTML 预览 | `HtmlPreviewBlock.tsx:72-79` | 🟢 300ms debounce | 防抖周期内不重建；但每次 `srcDoc` 变仍重载 iframe（🟠 白屏闪烁风险）→ 流式仅显示源码 |
| KaTeX/数学公式 | 全库零匹配 | — | 功能未实现，无解析开销 |
| `rehype-raw` | `markdown.tsx:4,13,84` | 🟡 | 正文每次全文 parse 额外 HTML 处理（ThinkingBlock/ReasoningSummary 未用，更轻） |

---

## 7. 正向发现（架构已做得好的部分，避免误改）

1. **三层节流架构**: provider 50ms（`toolInputDeltaThrottle.ts`）→ IPC 16ms（`streamCoalescer.ts`）→ renderer rAF（`streamingDeltaBatcher.ts`），设计清晰（见 `STREAM_SINKS.md`）。
2. **块合并算法**: `getBlockMergeKind`/`findMergeTargetIdx` 解决 Gemini 交错 delta 碎块（`applyBatchedDeltas.ts:67-109`）。
3. **排序保证**: 非 delta 事件前 `flushPendingDeltasNow`；首 tool delta 前 flush 避免 preamble 错位。
4. **ChatMessage memo 修复**: 引用相等替代旧版错误的 length 深比较（`helpers.ts:24-40`）；非流式行 `return m` 保持引用（`applyBatchedDeltas.ts:128-129`）。
5. **条件虚拟化 + 虚拟列表优化**: scroll rAF、共享 ResizeObserver、`pinToBottomRef` 锚定、虚拟化 flip 恢复双 snap。
6. **重型块防抖**: Mermaid 250ms / HTML 300ms / 流式 thinking 240px 裁剪。
7. **取消语义**: Stop 后丢弃 straggler delta，防止"Thinking 253s"失控（`applyBatchedDeltas.ts:130-137`）。
8. **Task output 旁路**: `useTaskOutput` 独立 IPC 订阅，减轻 ToolUseCard N×setState。
9. **巨型组件部分拆分**: SettingsDialog 1439→997 行、AgentsPanel 1749→~666 行（状态抽 hook）。
10. **焦点守卫主路径**: tab 切换/diff/pendingJump 均 `focusEditorIfIdle`，Monaco 挂载不抢焦点。

---

## 8. 推荐修复优先级（按"平滑度收益 / 改动成本"）

| 优先级 | 动作 | 预期收益 | 成本 |
|--------|------|---------|------|
| **P0** | §1 焦点守卫选择器 `.chat-input-textarea`→`.chat-input` | 消除"失焦 ~20s"残留现象 | 极低 |
| **P0** | §2.1 流式 Markdown 降级/限频/块级缓存 | 主聊天 prose 流畅度（最大热点） | 中 |
| **P0** | §2.3 ThinkingBlock 拆计时器与 markdown + `inView` 门控 | 长 reasoning 流畅度 | 中 |
| **P1** | §2.2 `tool_input_delta` 接入 rAF batcher + 局部 patch + 流式跳过 colorize | 大文件 Write/Edit 流畅度 | 中 |
| **P1** | §3.1 ToolUseCard/AgentBlock/ThinkingBlock memo + ActivityRow children 提取 | 减少流式整子树 reconcile | 中 |
| **P1** | §3.4 子代理接入 batcher + AgentBlock memo | 多子代理并行场景 | 中 |
| **P2** | §3.2 ChatPanel messages 订阅下沉 | 减少每 token 整面板调度 | 中高 |
| **P2** | §4 staticLayout 增量布局 + 流式跟底单通道 + RO rAF 合批 | 长会话流式 + 滚动 | 中 |
| **P2** | §5.1/§5.2 `editor:action` 加 guard + IME composition 护栏 | 焦点/中文输入鲁棒性 | 低中 |
| **P3** | §5.3 发送后 `buildMainChatApiMessagesForSend` 异步化 | 发送瞬间 hitch | 中 |
| **P3** | §5.4 SkillPopup useMemo / §6 富内容 memo / 流式仅源码 | 边际优化 | 低 |

---

## 附：子智能体审计链接

- 流式数据管线: [流式管线审计](e4006387-e7f4-4c56-8fd2-0530b91b4056)
- React 渲染粒度: [渲染粒度审计](03798f50-69a4-4b1a-8930-1b726e80f2fd)
- 滚动与虚拟化: [滚动虚拟化审计](6b9c5d78-0e3d-4154-929d-bcc2b4f59209)
- 输入框与焦点: [输入焦点审计](a27bcc4b-c80f-4402-ac1c-2f19c747151d)
- 富内容渲染: [富内容渲染审计](b3feece6-e619-4ae7-a5f7-6f19377bc3e7)
