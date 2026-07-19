/**
 * Built-in rule presets surfaced in Settings → 规则管理 → 预设面板。
 *
 * 预设默认全部未启用；用户在面板里勾选「启用」后，id 写入 localStorage
 * `ENABLED_PRESETS_KEY`。运行期由 {@link buildUserRulesPromptFromStorage}
 * 把启用项的 content 与用户自建规则合并后注入系统提示词。
 *
 * id 形如 `preset-<...>`，与「用户自建规则」的 `rule-<timestamp>` id 命名空间不冲突，
 * 这样未来若要回收 / 迁移 / 升级，可以靠 `isPresetId` 一眼分辨。
 *
 * 添加新预设：
 *   1. 在 RULE_PRESETS 末尾追加；id 必须以 `preset-` 开头并保持唯一。
 *   2. 选择合适的 type（user = 个人偏好；project = 工程规范）和 category（仅作元数据）。
 *   3. content 是 Markdown，会原样进系统提示词，建议用「- 」要点句，单条 < ~10 行。
 */

import type { StoredRule } from './userRulesPrompt'

export type RulePresetCategory = 'habit' | 'quality' | 'language' | 'security'

export interface RulePreset {
  /** 稳定 id，必须以 `preset-` 开头；同时也是 localStorage 启用集合里的 id。 */
  id: string
  /** user = 跟随所有项目的个人偏好；project = 当前项目的工程规范。 */
  type: 'user' | 'project'
  /** 元数据：分类，便于后续按组展示/搜索（当前 UI 仅按 type 分组）。 */
  category: RulePresetCategory
  name: string
  description: string
  /** 系统提示词正文（Markdown）。 */
  content: string
}

export const ENABLED_PRESETS_KEY = 'claude-rules-enabled-presets'

export const RULE_PRESETS: RulePreset[] = [
  // ── 用户级（个人编码风格偏好） ─────────────────────────────────
  {
    id: 'preset-user-concise',
    type: 'user',
    category: 'habit',
    name: '简洁沟通',
    description: '跳过铺垫直接作答，always-apply 内容尽量控制在 200 字以内。',
    content: [
      '- 直接给答案。不要铺垫、不要客套，比如"好问题！"之类的话一律省略。',
      '- 先给代码，再用 1-3 句话解释要点。',
      '- always-apply 类规则控制在约 200 字以内，避免占用上下文窗口。',
      '- 用要点列表代替长段落；除非用户要求，不要使用 emoji。',
    ].join('\n'),
  },
  {
    id: 'preset-user-plan-first',
    type: 'user',
    category: 'habit',
    name: '先规划再编码',
    description: '非简单改动先列方案、列受影响文件、显式声明假设。',
    content: [
      '- 任何非简单改动，先给出实现方案再开始写代码。',
      '- 列出会被修改的文件/模块，并说明每一处的修改原因。',
      '- 显式声明你做出的假设；如有不确定的地方主动询问。',
      '- 优先采用"接口先行"的设计：先定义类型/契约，再实现细节。',
    ].join('\n'),
  },
  {
    id: 'preset-user-verify',
    type: 'user',
    category: 'habit',
    name: '完成前自检',
    description: '宣称完成前先跑类型检查 / lint / 测试，禁止留 TODO 占位。',
    content: [
      '- 说"完成"之前，先跑项目的类型检查、Linter 和测试。',
      '- 最终输出中不允许出现占位代码、TODO 或 mock 实现。',
      '- 如果某些验证无法执行，请明确说明，并列出被跳过的项。',
      '- 用具体证据（命令 + 输出）替代"应该没问题"这类含糊措辞。',
    ].join('\n'),
  },
  {
    id: 'preset-user-plan-granularity',
    type: 'user',
    category: 'habit',
    name: '规划颗粒度',
    description: '按改动规模匹配规划深度，小改不啰嗦、大改不裸冲。',
    content: [
      '- 改动 1-2 行或单文件小改：直接动手，不写计划，不列 TODO。',
      '- 涉及 3 个以上文件、新增对外接口或跨模块改动：先列「涉及文件 → 每处改什么 → 如何验证」三栏，再写代码。',
      '- 重构 / 迁移 / 大幅重写：先写一段方案（要解决的问题、显式不动哪些边界、回滚路径），获得确认后再动工。',
      '- 不为简单任务塞 TODO 列表，也不为复杂任务跳过规划直接写代码。',
      '- 任务拆分时，每个子步骤都要有「可验证的产出」：一段函数、一个测试通过、一段命令输出。',
      '- 计划落地时按依赖顺序执行，先完成上游产出，避免后续步骤被前序假设污染。',
    ].join('\n'),
  },
  {
    id: 'preset-user-code-quality',
    type: 'user',
    category: 'quality',
    name: '代码质量基线',
    description: '可读 / 可维护 / 可测试优先，警惕显著低效写法。',
    content: [
      '- 函数单一职责，命名表达「做什么」而非「怎么做」；含义不清的缩写一律展开。',
      '- 错误向上抛而不是吞掉；只在能给出有意义恢复行为的边界 catch，并保留原始堆栈。',
      '- 导出函数 / 公共 API / 工具必须有显式类型；注释只解释「为什么这样写」，不复述代码本身。',
      '- 新增前先搜项目已有的 utils / services / hooks，能复用就复用，命名沿用邻近模块的约定。',
      '- 不引入未被需要的抽象、配置项、参数（YAGNI）；一次性逻辑不抽函数 / 不开 hook。',
      '- 警惕显著低效写法：循环里发 IO、N+1 查询、对大数据全量 JSON.parse、不必要的深拷贝。',
      '- 关键路径日志要带上下文（请求 id、关键参数、耗时），孤零零的「here」「ok」属于噪音应删除。',
      '- 修 bug 时先写一个能复现的测试再改实现，并把测试留在仓库里防止回归。',
    ].join('\n'),
  },

  // ── 项目级（工程规范） ─────────────────────────────────────────
  {
    id: 'preset-project-ts-strict',
    type: 'project',
    category: 'language',
    name: 'TypeScript 严格模式',
    description: '禁用 any，优先 interface，强制严格空检查与显式返回类型。',
    content: [
      '- 禁止使用 `any`。优先使用 `unknown` + 类型收窄，或者精确类型。',
      '- 对象形状可能被扩展时，优先使用 `interface` 而不是 `type`。',
      '- tsconfig 中开启 `strict`，遵守 `strictNullChecks` 与 `noImplicitAny`。',
      '- 导出的函数和公共 API 必须显式声明返回类型。',
      '- 不要用 `// @ts-ignore` 屏蔽错误——要么修类型，要么用 `// @ts-expect-error` 并附原因注释。',
    ].join('\n'),
  },
  {
    id: 'preset-project-react',
    type: 'project',
    category: 'language',
    name: 'React 最佳实践',
    description: '函数组件 + Hooks、依赖数组正确、稳定 key、热路径做好 memo。',
    content: [
      '- 一律使用函数组件和 Hooks，不再写 class 组件。',
      '- `useEffect` / `useMemo` / `useCallback` 的依赖数组必须完整且正确。',
      '- 列表必须使用稳定且唯一的 `key`，可变列表禁止用数组下标作为 key。',
      '- 状态只提升到必要的层级，能 colocate 就 colocate。',
      '- 渲染热路径中昂贵的子组件或回调要做 memoization。',
      '- 渲染期间禁止副作用，副作用放进 effect 或事件处理器里。',
    ].join('\n'),
  },
  {
    id: 'preset-project-security',
    type: 'project',
    category: 'security',
    name: '安全优先',
    description: '密钥不入库、输入校验、安全 HTML、参数化查询。',
    content: [
      '- 禁止把密钥、API Key、令牌提交到仓库；统一从环境变量或密钥管理服务读取。',
      '- 所有外部输入（HTTP body、query、header、文件）都要做校验与过滤。',
      '- 输出要做转义/编码；不要直接渲染未经清洗的 HTML。',
      '- 数据库查询必须用参数化 / ORM——禁止字符串拼接 SQL。',
      '- 使用前先核实包名和 API 签名（防幻觉）。',
      '- 文件系统、网络、Shell 访问遵循最小权限原则。',
    ].join('\n'),
  },
]

export function presetToStoredRule(preset: RulePreset): StoredRule {
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    type: preset.type,
    content: preset.content,
  }
}

export function isPresetId(id: string): boolean {
  return typeof id === 'string' && id.startsWith('preset-')
}

export const PRESET_CATEGORY_LABELS: Record<RulePresetCategory, string> = {
  habit: '工作习惯',
  quality: '质量 / 测试',
  language: '语言 / 框架',
  security: '安全底线',
}
