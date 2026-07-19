/**
 * teamFlowToMermaid —— 根据 TeamTemplate 生成 mermaid flowchart 源码。
 *
 * 五种协调方式对应五种图形式：
 *
 *   solo        用户 ─► 单成员 ─► 输出
 *   parallel    用户 ┬► A ┐
 *                     ├► B ┤► 输出
 *                     └► C ┘
 *   sequential  用户 ─► [stage0 并行] ─► [stage1 并行] ─► 输出
 *   swarm       用户 ─► MUX ◄► A / ◄► B / ─► 输出
 *   coordinator 用户 ─► 协调者 ◄► A / ◄► B / ─► 输出
 *
 * 节点 id 用 `n0/n1/...` 等短名字保证符合 mermaid 语法;显示文字从
 * bundle.agents 里查 displayName,失败回退到 agentType。
 *
 * 所有 label 中的特殊字符 (`"`, `[`, `]`, `{`, `}`, `(`, `)`, `:`, `;`, `|`,
 * 换行等) 会被清洗为无害替代,避免破坏 mermaid 解析。
 */

import type { Bundle, TeamMember, TeamTemplate } from '../../../electron/agents/bundles/types'
import type { Messages } from '../../i18n'

type TeamFlowLabels = Messages['workbench']['teamFlow']

/** 把任意字符串转为 mermaid flowchart 里安全的 `"..."` 节点 label。 */
function safeLabel(raw: string): string {
  return raw
    // 移除 Mermaid 语法关键字符,避免破坏 flowchart 解析:
    //   "  → 引号定界符
    //   <> → 箭头/HTML 标签
    //   [] → 矩形节点
    //   {} → 菱形/六边形节点
    //   () → 圆角节点
    //   :; → 节点 ID 分隔符
    //   |  → 连线文本分隔符
    .replace(/[[\]{}():;|"<>]/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) // 再长也截断,防止过大图
}

function memberLabel(member: TeamMember, bundle: Bundle): string {
  const agent = bundle.agents.find((a) => a.agentType === member.agentType)
  const name = agent?.displayName ?? member.agentType
  if (!member.role) return name
  // Mermaid 9.x 不支持节点 label 内嵌 <br/>; 用换行符替代。
  return `${name}\n${member.role}`
}

/** 拼一个节点的完整 mermaid 语句:`id["label"]` / `id((label))` / `id{{label}}`。
 *  shape 决定视觉风格。 */
type NodeShape = 'rect' | 'round' | 'hex' | 'diamond'
function node(id: string, label: string, shape: NodeShape = 'rect'): string {
  const lab = safeLabel(label)
  // label 里可能含中文,mermaid 需要 `"..."` 包裹才不会因空格 / 标点破锁。
  const content = `"${lab.replace(/"/g, "'")}"`
  switch (shape) {
    case 'round':
      return `${id}((${content}))`
    case 'hex':
      return `${id}{{${content}}}`
    case 'diamond':
      return `${id}{${content}}`
    default:
      return `${id}[${content}]`
  }
}

const USER_NODE = 'nUser'
const OUT_NODE = 'nOut'

/** sequential 协调使用:按 parallelGroup 分桶,未设 group 的一律进桶 0。
 *  返回按 group 索引升序排列的二维数组。 */
function groupByStage(members: TeamMember[]): TeamMember[][] {
  const buckets = new Map<number, TeamMember[]>()
  for (const m of members) {
    const g = typeof m.parallelGroup === 'number' ? m.parallelGroup : 0
    const arr = buckets.get(g) ?? []
    arr.push(m)
    buckets.set(g, arr)
  }
  return [...buckets.keys()]
    .sort((a, b) => a - b)
    .map((k) => buckets.get(k)!)
}

/** 猜一个 "协调者" member:role 里含 "coord" 的优先,否则数组第一项。
 *  返回 null 表示没有成员。 */
function pickCoordinator(members: TeamMember[]): TeamMember | null {
  if (members.length === 0) return null
  const byRole = members.find(
    (m) => typeof m.role === 'string' && /coord/i.test(m.role),
  )
  return byRole ?? members[0]
}

export interface TeamFlowResult {
  /** Mermaid flowchart 源码;若无法生成图(如空成员)为空字符串。 */
  code: string
  /** 若空图的原因需要展示给用户,这里是中文说明;否则为空字符串。 */
  emptyReason: string
}

export function teamFlowToMermaid(team: TeamTemplate, bundle: Bundle, labels: TeamFlowLabels): TeamFlowResult {
  if (team.members.length === 0) {
    return {
      code: '',
      emptyReason: labels.emptyNoMembers,
    }
  }

  const userLine = node(USER_NODE, labels.userNode, 'round')
  const outLine = node(OUT_NODE, labels.outputNode, 'round')
  const lines: string[] = []

  switch (team.coordination) {
    case 'solo': {
      // 仅渲染第一个成员(或 primary role 的成员 —— 这里简化:取第 1 个)。
      const m = team.members[0]
      const nid = 'n0'
      lines.push('flowchart LR')
      lines.push(`  ${userLine}`)
      lines.push(`  ${node(nid, memberLabel(m, bundle))}`)
      lines.push(`  ${outLine}`)
      lines.push(`  ${USER_NODE} --> ${nid}`)
      lines.push(`  ${nid} --> ${OUT_NODE}`)
      if (team.members.length > 1) {
        lines.push(
          `  %% 其余 ${team.members.length - 1} 位成员未参与运行(solo 协调下仅首位触发)`,
        )
      }
      break
    }

    case 'parallel': {
      lines.push('flowchart LR')
      lines.push(`  ${userLine}`)
      team.members.forEach((m, i) => {
        const nid = `n${i}`
        lines.push(`  ${node(nid, memberLabel(m, bundle))}`)
        lines.push(`  ${USER_NODE} --> ${nid}`)
        lines.push(`  ${nid} --> ${OUT_NODE}`)
      })
      lines.push(`  ${outLine}`)
      break
    }

    case 'sequential': {
      const stages = groupByStage(team.members)
      lines.push('flowchart LR')
      lines.push(`  ${userLine}`)
      lines.push(`  ${outLine}`)
      // 给每个成员分配全局 nid
      const idMap = new Map<TeamMember, string>()
      let counter = 0
      for (const stage of stages) {
        for (const m of stage) {
          const nid = `n${counter++}`
          idMap.set(m, nid)
          lines.push(`  ${node(nid, memberLabel(m, bundle))}`)
        }
      }
      // 用户连到第 0 阶段所有成员
      for (const m of stages[0]) {
        lines.push(`  ${USER_NODE} --> ${idMap.get(m)!}`)
      }
      // 阶段 i 的每个成员 → 阶段 i+1 的每个成员(扇入扇出)
      for (let i = 0; i < stages.length - 1; i++) {
        for (const from of stages[i]) {
          for (const to of stages[i + 1]) {
            lines.push(`  ${idMap.get(from)!} --> ${idMap.get(to)!}`)
          }
        }
      }
      // 最后阶段 → 输出
      for (const m of stages[stages.length - 1]) {
        lines.push(`  ${idMap.get(m)!} --> ${OUT_NODE}`)
      }
      break
    }

    case 'swarm': {
      lines.push('flowchart LR')
      lines.push(`  ${userLine}`)
      lines.push(`  ${node('nMux', labels.muxNode, 'hex')}`)
      lines.push(`  ${USER_NODE} --> nMux`)
      team.members.forEach((m, i) => {
        const nid = `n${i}`
        lines.push(`  ${node(nid, memberLabel(m, bundle))}`)
        // 双向箭头表示 multiplexer 和成员互相递消息
        lines.push(`  nMux <--> ${nid}`)
      })
      lines.push(`  nMux --> ${OUT_NODE}`)
      lines.push(`  ${outLine}`)
      break
    }

    case 'coordinator': {
      const coord = pickCoordinator(team.members)
      if (!coord) {
        return {
          code: '',
          emptyReason: labels.emptyNoCoordinator,
        }
      }
      lines.push('flowchart LR')
      lines.push(`  ${userLine}`)
      lines.push(
        `  ${node('nCoord', `${memberLabel(coord, bundle)}\n${labels.coordinatorSuffix}`, 'diamond')}`,
      )
      lines.push(`  ${USER_NODE} --> nCoord`)
      const workers = team.members.filter((m) => m !== coord)
      if (workers.length === 0) {
        // 没有被调度方,协调者直接到输出
        lines.push(`  nCoord --> ${OUT_NODE}`)
      } else {
        workers.forEach((m, i) => {
          const nid = `nW${i}`
          lines.push(`  ${node(nid, memberLabel(m, bundle))}`)
          // 协调者派发 + 成员回传
          lines.push(`  nCoord --> ${nid}`)
          lines.push(`  ${nid} --> nCoord`)
        })
        lines.push(`  nCoord --> ${OUT_NODE}`)
      }
      lines.push(`  ${outLine}`)
      break
    }

    default: {
      // 未来新增协调方式时的兜底:列出所有成员并连接到输出。
      lines.push('flowchart LR')
      lines.push(`  ${userLine}`)
      lines.push(`  ${outLine}`)
      team.members.forEach((m, i) => {
        const nid = `n${i}`
        lines.push(`  ${node(nid, memberLabel(m, bundle))}`)
        lines.push(`  ${USER_NODE} --> ${nid}`)
        lines.push(`  ${nid} --> ${OUT_NODE}`)
      })
    }
  }

  // 统一节点样式:user / output 淡灰,成员边框用主题色。mermaid themeVariables
  // 已处理大部分;这里用 classDef 给 user/output 加一点差异。
  lines.push('')
  lines.push('  classDef terminus fill:#181825,stroke:#6c7086,color:#a6adc8')
  lines.push(`  class ${USER_NODE},${OUT_NODE} terminus`)

  return { code: lines.join('\n'), emptyReason: '' }
}
