/**
 * Placeholder prompt helpers for freshly-created bundles.
 */

import type { AgentBundleEntry, Bundle } from './types'

/** Default placeholder agent injected into freshly-created bundles so
 *  `validateBundleSemantics` (which requires `agents.length >= 1`) is
 *  satisfied. User can rename/replace via the Workbench.
 *
 *  重要:prompt 必须**带上工作包 meta 上下文**(name / domain / description),
 *  否则用户建完工作包还没来得及填模板就开问,AI 只会回"我是通用 AI 助手"。
 *  个性化占位 prompt 让主智能体至少知道自己代表哪个行业团队,即便用户
 *  没进工作台配置,首轮对话也能进入角色。 */
const PLACEHOLDER_AGENT_TYPE = 'assistant'
/** 出现在占位 prompt 首行;加载时据此识别旧版占位并就地升级,避免用户
 *  历史工作包永远卡在"我是通用 AI 助手"。 */
const PLACEHOLDER_PROMPT_MARKER = '<!-- ASTRA_PLACEHOLDER_V2 -->'
const LEGACY_PLACEHOLDER_PROMPT =
  '你是一个通用 AI 助手。请根据用户的指令提供帮助；在需要澄清时主动询问。'

export function makePlaceholderPrompt(meta: {
  name: string
  domain?: string
  description?: string
}): string {
  const name = meta.name?.trim() || '未命名工作包'
  const domain = meta.domain?.trim()
  const desc = meta.description?.trim()
  const lines: string[] = []
  lines.push(PLACEHOLDER_PROMPT_MARKER)
  lines.push(`你是「${name}」工作包的主智能体,用户直接对话的就是你。`)
  if (domain) lines.push(`你所服务的领域是「${domain}」。`)
  if (desc) lines.push(`工作包描述:${desc}`)
  lines.push('')
  lines.push('## 你现在的状态')
  lines.push(
    '用户刚刚创建或打开这个工作包,还没有在「智能体工作台 → 提示词」里给你写详细的角色定位、核心能力、工作准则等。所以你暂时只有工作包的名字和描述作为身份线索。',
  )
  lines.push('')
  lines.push('## 在用户完善配置之前,你应当')
  lines.push(
    '- **先接住用户**:友好简明地自我介绍,基于工作包名字和领域合理推断自己该帮什么(比如"售前工程师"显然是做方案/标书/报价的,不需要等用户解释)',
  )
  lines.push(
    '- **主动澄清需求**:问清楚用户当前具体想完成什么任务,再决定怎么配合',
  )
  lines.push(
    '- **善用团队其他成员**:如果工作包里还定义了子智能体,可以用 Agent 工具(`subagent_type` 指定对应 agentType)派活让他们处理专业任务,然后把结果汇总给用户',
  )
  lines.push(
    '- **适时提醒配置**:当你发现自己需要更具体的行业规范/话术/模板才能把活干漂亮时,告诉用户可以打开「智能体工作台」完善你的提示词配置',
  )
  lines.push('')
  lines.push('## 不要做的事')
  lines.push('- 不要死板地回答"我是通用 AI 助手"——你是有行业定位的')
  lines.push('- 不要把"配置还没填"当挡箭牌拒绝工作,尽量先干起来')
  return lines.join('\n')
}

export function makePlaceholderAgent(meta: {
  name: string
  domain?: string
  description?: string
}): AgentBundleEntry {
  return {
    agentType: PLACEHOLDER_AGENT_TYPE,
    displayName: '助手',
    whenToUse: `「${meta.name}」工作包的默认主智能体,负责接待用户并协调其它成员。`,
    isPrimary: true,
    systemPromptRaw: makePlaceholderPrompt(meta),
  }
}

/**
 * 迁移:用户已有的工作包里,主智能体如果还卡在老版占位 prompt(死板的
 * "你是一个通用 AI 助手..."),把它就地升级成个性化占位 prompt。仅改动
 * 内存态,下一次 saveAgent/saveBundleMeta 时随 persist 一起落盘。这样
 * 用户不用删重建,开发者也不用手动改 JSON。
 *
 * 触发条件(必须同时满足,防误伤):
 *   - agent 是 primary
 *   - 要么 systemPromptRaw 完全等于老占位文本
 *   - 要么 promptSections 只有一个 body 等于老占位文本的条目
 */
export function maybeUpgradeLegacyPlaceholder(bundle: Bundle): boolean {
  let changed = false
  for (const agent of bundle.agents ?? []) {
    if (!agent.isPrimary) continue
    const matchesRaw =
      typeof agent.systemPromptRaw === 'string' &&
      agent.systemPromptRaw.trim() === LEGACY_PLACEHOLDER_PROMPT.trim()
    const sections = Array.isArray(agent.promptSections) ? agent.promptSections : []
    const matchesSection =
      sections.length === 1 &&
      typeof sections[0].body === 'string' &&
      sections[0].body.trim() === LEGACY_PLACEHOLDER_PROMPT.trim()
    if (!matchesRaw && !matchesSection) continue
    const newPrompt = makePlaceholderPrompt({
      name: bundle.meta.name,
      domain: bundle.meta.domain,
      description: bundle.meta.description,
    })
    agent.systemPromptRaw = newPrompt
    // 清掉结构化段落,让 systemPromptRaw 成为唯一真相源
    if (sections.length > 0) agent.promptSections = undefined
    changed = true
  }
  return changed
}
