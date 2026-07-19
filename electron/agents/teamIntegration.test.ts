/**
 * TEAM 集成测试 — 覆盖极端测试报告中的 T-01 到 T-20 场景（后端部分）。
 *
 * 不涉及真实 LLM 调用。测试 TeamFile 持久化、成员注册、消息路由、
 * 并发写入安全、名称 sanitization 等。
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// 纯函数 — 无依赖
import {
  teamMemberIds,
  teamHasMember,
  appendTeamMemberSlot,
  sanitizeTeamFileBase,
  TEAM_FILE_VERSION,
  type TeamMemberSlot,
} from '../tools/teamFileShared'

// 文件集成 — 需要临时目录
import { appendTeamMailbox, peekTeamMailbox, readAndClearTeamMailbox } from '../tools/teamMailbox'
import {
  persistTeamFile,
  loadTeamFile,
  broadcastTeamMessage,
  deleteTeamFile,
  clearTeams,
  type Team,
} from '../tools/TeamCreateTool'
import { clearAllLocks } from '../tools/fileLock'
import { asAgentId } from '../tools/ids'

// Team Active Loop (PR-5 end-to-end coverage) — see docs/plans/team-active-loop.md
import { sendTeammateIdleNotification } from './teamIdleNotifier'
import { sendTaskAssignmentNotification } from './teamTaskAssignmentNotifier'
import {
  DEFAULT_MAX_CONSECUTIVE_CLAIMS,
  tryClaimNextTask,
} from './teamTaskAutoClaim'
import { readAndRenderTeamInbox } from './teamInboxAttachments'
import {
  parseTeamInterAgentLine,
} from './teamInterAgentProtocol'
import { runWithAgentContextAsync, type AgentContext } from './agentContext'
import { taskManager } from '../tools/TaskManager'
import { taskUpdateTool } from '../tools/TaskUpdateTool'
import { getWorkspacePath, setWorkspacePath } from '../tools/workspaceState'

// 纯测试 — teamAutoLauncher
import {
  buildTeamLaunchPlan,
  launchTeamFromTemplateAsync,
  type PlannedTeamMemberLaunchRequest,
} from './teamAutoLauncher'
import type { TeamTemplate, TeamCoordination } from './bundles/types'
import type { SubAgentResult } from './types'

// ================================================================
// 测试辅助
// ================================================================

let workspaceRoot: string

function mkTemplate(
  coordination: TeamCoordination,
  members: Array<{ agentType: string; role?: string; parallelGroup?: number }>,
): TeamTemplate {
  return {
    id: `tpl-${Math.random().toString(36).slice(2, 6)}`,
    name: 'Test Team',
    description: 'fixture',
    coordination,
    members,
  }
}

function stubResult(agentType: string, output = 'ok'): SubAgentResult {
  return {
    success: true,
    agentId: asAgentId(`stub-${agentType}-${Math.random().toString(36).slice(2, 8)}`),
    agentType,
    output,
    totalTokens: 0,
    totalDurationMs: 1,
    totalToolUses: 0,
  }
}

function createTestTeam(teamName: string, members: string[] = []): Team {
  return {
    teamName,
    leadAgentId: `lead-${teamName}`,
    members: [`lead-${teamName}`, ...members],
    createdAt: Date.now(),
    mailbox: {},
  }
}

beforeAll(async () => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-team-int-'))
})

afterAll(() => {
  try {
    fs.rmSync(workspaceRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

afterEach(() => {
  clearAllLocks({ force: true })
  clearTeams()
})

// ================================================================
// 纯函数测试
// ================================================================

describe('teamFileShared — 纯函数', () => {
  describe('teamMemberIds', () => {
    it('混合字符串和对象槽位', () => {
      const slots: TeamMemberSlot[] = [
        'alice',
        { agentId: 'bob', name: 'Bob' },
        '  charlie ',
        { agentId: 'dave' },
        '',
        '  ', // 仅空白
      ]
      const ids = teamMemberIds(slots)
      expect(ids).toEqual(['alice', 'bob', 'charlie', 'dave'])
    })

    it('空数组返回空', () => {
      expect(teamMemberIds([])).toEqual([])
    })

    it('undefined 返回空', () => {
      expect(teamMemberIds(undefined)).toEqual([])
    })
  })

  describe('teamHasMember', () => {
    it('存在的成员返回 true', () => {
      const slots: TeamMemberSlot[] = [
        'lead',
        { agentId: 'worker', name: 'W' },
      ]
      expect(teamHasMember(slots, 'lead')).toBe(true)
      expect(teamHasMember(slots, 'worker')).toBe(true)
    })

    it('不存在的成员返回 false', () => {
      expect(teamHasMember(['lead'], 'ghost')).toBe(false)
    })

    it('空 agentId 返回 false', () => {
      expect(teamHasMember(['lead'], '')).toBe(false)
    })
  })

  describe('appendTeamMemberSlot', () => {
    it('追加新成员', () => {
      const updated = appendTeamMemberSlot(['lead'], 'worker')
      expect(updated).toEqual(['lead', 'worker'])
    })

    it('重复添加不产生重复项', () => {
      const updated = appendTeamMemberSlot(['lead', 'worker'], 'lead')
      expect(updated).toEqual(['lead', 'worker'])
    })
  })

  describe('sanitizeTeamFileBase', () => {
    it('T-10: 路径遍历被阻止 — 斜杠被替换为下划线', () => {
      const s = sanitizeTeamFileBase('../../../etc/passwd')
      // / 被 _ 替换，".." 本身是安全的文件名片段
      expect(s).not.toContain('/')
      expect(s).not.toContain('\\')
      expect(s).toBe('.._.._.._etc_passwd')
    })

    it('T-10: script 标签被过滤', () => {
      const s = sanitizeTeamFileBase('<script>alert(1)</script>')
      expect(s).not.toContain('<')
      expect(s).not.toContain('>')
    })

    it('T-10: 反斜杠路径遍历', () => {
      const s = sanitizeTeamFileBase('..\\..\\windows\\system32')
      expect(s).not.toContain('\\')
    })

    it('T-10: 空字符串回退为 "team"', () => {
      const s = sanitizeTeamFileBase('')
      expect(s).toBe('team')
    })

    it('T-10: 仅特殊字符回退为 _ 而非 team（非空字符串不会触底）', () => {
      const s = sanitizeTeamFileBase('@#$%^&*()')
      // 所有特殊字符 → _，连续的 _ 合并为单个 _，结果非空
      expect(s).toBe('_')
    })

    it('T-10: 中文团队名被替换为下划线', () => {
      const s = sanitizeTeamFileBase('开发团队')
      expect(s).not.toMatch(/[\u4e00-\u9fff]/)
      expect(s.length).toBeGreaterThan(0)
    })

    it('T-10: 超长名被截断到 120 字符', () => {
      const long = 'a'.repeat(200)
      const s = sanitizeTeamFileBase(long)
      expect(s.length).toBeLessThanOrEqual(120)
    })

    it('T-10: 合法字符保留', () => {
      const s = sanitizeTeamFileBase('my-team_v1.0')
      expect(s).toBe('my-team_v1.0')
    })

    it('T-10: 50 个恶意输入全安全', () => {
      const inputs = [
        '../../../etc/passwd',
        '..\\..\\windows\\system32',
        '<script>alert(1)</script>',
        '${PATH}',
        '`rm -rf /`',
        '; DROP TABLE teams;',
        '|| echo hacked ||',
        '$(whoami)',
        'cmd.exe',
        'AUX',
        'CON',
        'NUL',
        'a'.repeat(300),
        '',
        '   ',
        '\x00null',
        '\nnewline',
        '\ttab',
        'team name with spaces',
        'team{brace}',
        'team[brace]',
        'team(brace)',
        'team|pipe',
        'team?question',
        'team*star',
        'team!exclaim',
        'team#hash',
        'team@at',
        'team%percent',
        'team^caret',
        'team&and',
        'team=equals',
        'team+plus',
        'team:colon',
        'team;colon',
        'team\'quote',
        'team"dquote',
        'team,comma',
        'team<angle',
        'team>angle',
        'C:\\Windows',
        '/etc/shadow',
        '..\\.\\.\\',
        '~/root',
        '中文测试',
        '日本語テスト',
        '한국어테스트',
        'team with 🚀 emoji',
        'тест',
        'équipe',
      ]
      for (const input of inputs) {
        const s = sanitizeTeamFileBase(input)
        // 不应包含路径分隔符
        expect(s).not.toMatch(/[/\\<>]/)
        // 不应为空（回退为 'team'）
        expect(s.length).toBeGreaterThan(0)
        // 不应超出 120 字符
        expect(s.length).toBeLessThanOrEqual(120)
      }
    })
  })

  describe('TEAM_FILE_VERSION', () => {
    it('T-19: TEAM_FILE_VERSION = 1', () => {
      expect(TEAM_FILE_VERSION).toBe(1)
    })
  })
})

// ================================================================
// TeamFile 持久化测试
// ================================================================

describe('TeamFile 持久化 (集成)', () => {
  afterEach(async () => {
    // 清理测试团队文件
    for (const name of ['alpha', 'beta', 'gamma', 'full-lifecycle']) {
      try {
        await deleteTeamFile(workspaceRoot, name)
      } catch {
        /* ignore */
      }
    }
    clearAllLocks({ force: true })
  })

  it('persistTeamFile → loadTeamFile 往返一致', async () => {
    const team = createTestTeam('alpha', ['worker-1', 'worker-2'])
    await persistTeamFile(workspaceRoot, team)

    const loaded = loadTeamFile(workspaceRoot, 'alpha')
    expect(loaded).not.toBeNull()
    expect(loaded?.teamName).toBe('alpha')
    expect(loaded?.leadAgentId).toBe('lead-alpha')
    expect(teamMemberIds(loaded?.members)).toEqual(['lead-alpha', 'worker-1', 'worker-2'])
  })

  it('T-12: 多个团队创建不冲突', async () => {
    const t1 = createTestTeam('alpha', ['w1'])
    const t2 = createTestTeam('beta', ['w2'])
    const t3 = createTestTeam('gamma', ['w3'])

    await persistTeamFile(workspaceRoot, t1)
    await persistTeamFile(workspaceRoot, t2)
    await persistTeamFile(workspaceRoot, t3)

    const a = loadTeamFile(workspaceRoot, 'alpha')
    const b = loadTeamFile(workspaceRoot, 'beta')
    const g = loadTeamFile(workspaceRoot, 'gamma')

    expect(a?.teamName).toBe('alpha')
    expect(b?.teamName).toBe('beta')
    expect(g?.teamName).toBe('gamma')
  })

  it('T-01: appendTeamMemberSlot 幂等（同一 agentId 添加两次不重复）', () => {
    // ensureTeamMember 内部调用 getWorkspacePath()，测试中用底层
    // appendTeamMemberSlot + persistTeamFile 验证幂等逻辑。
    const team = createTestTeam('alpha', ['worker-1'])
    team.members = appendTeamMemberSlot(team.members, 'worker-2')
    team.members = appendTeamMemberSlot(team.members, 'worker-2')
    const ids = teamMemberIds(team.members)
    expect(ids.filter((id) => id === 'worker-2')).toHaveLength(1)
  })

  it('T-01: 5 个不同 agentId 通过 appendTeamMemberSlot 全部保留', async () => {
    const team = createTestTeam('alpha')
    const agentIds = ['a1', 'a2', 'a3', 'a4', 'a5']
    for (const id of agentIds) {
      team.members = appendTeamMemberSlot(team.members, id)
    }
    await persistTeamFile(workspaceRoot, team)

    const loaded = loadTeamFile(workspaceRoot, 'alpha')
    const ids = teamMemberIds(loaded?.members)
    for (const id of agentIds) {
      expect(ids).toContain(id)
    }
    expect(ids).toContain('lead-alpha')
  })

  it('T-20: 完整生命周期 Create → Broadcast → Status → Delete', async () => {
    const team = createTestTeam('full-lifecycle', ['worker-a', 'worker-b'])
    await persistTeamFile(workspaceRoot, team)

    // 验证存在
    expect(loadTeamFile(workspaceRoot, 'full-lifecycle')).not.toBeNull()

    // 广播消息（不涉及真实 agent）
    const result = await broadcastTeamMessage(
      workspaceRoot,
      'full-lifecycle',
      'lead-full-lifecycle',
      '团队广播消息',
    )
    // delivered 可能为 0（无 active agent），但不抛异常
    expect(typeof result.delivered).toBe('number')

    // 删除
    const deleted = await deleteTeamFile(workspaceRoot, 'full-lifecycle')
    expect(deleted).toBe(true)

    // 验证已删除
    expect(loadTeamFile(workspaceRoot, 'full-lifecycle')).toBeNull()
  })

  it('deleteTeamFile 对不存在的团队返回 false', async () => {
    const deleted = await deleteTeamFile(workspaceRoot, 'nonexistent')
    expect(deleted).toBe(false)
  })

  it('Bug T-13 回归：deleteTeamFile 同时清理 inboxes/ 镜像目录', async () => {
    const teamName = 't13-inbox-cleanup'
    const team: Team = {
      teamName,
      leadAgentId: 'lead-t13',
      members: ['lead-t13', 'worker-t13'],
      createdAt: Date.now(),
      mailbox: {},
    }
    await persistTeamFile(workspaceRoot, team)

    // Manually create the inbox dir + a member inbox file (simulates
    // what `mirrorTeamMailboxToInboxFiles` writes during normal operation).
    const teamSeg = sanitizeTeamFileBase(teamName)
    const inboxDir = path.join(workspaceRoot, '.claude', 'teams', teamSeg, 'inboxes')
    fs.mkdirSync(inboxDir, { recursive: true })
    fs.writeFileSync(
      path.join(inboxDir, 'worker-t13.json'),
      '{"messages":["hi"]}',
      'utf8',
    )

    expect(fs.existsSync(inboxDir)).toBe(true)

    const deleted = await deleteTeamFile(workspaceRoot, teamName)
    expect(deleted).toBe(true)

    // Inbox dir + parent team dir should both be cleaned up.
    expect(fs.existsSync(inboxDir)).toBe(false)
    const teamDir = path.dirname(inboxDir)
    expect(fs.existsSync(teamDir)).toBe(false)
  })
})

// ================================================================
// TeamMailbox 测试
// ================================================================

describe('TeamMailbox (集成)', () => {
  beforeAll(async () => {
    const team: Team = {
      teamName: 'mailbox-team',
      leadAgentId: 'lead-mb',
      members: ['lead-mb', 'worker-mb'],
      createdAt: Date.now(),
      mailbox: {},
    }
    await persistTeamFile(workspaceRoot, team)
  })

  afterAll(async () => {
    try {
      await deleteTeamFile(workspaceRoot, 'mailbox-team')
    } catch {
      /* ignore */
    }
  })

  afterEach(() => {
    clearAllLocks({ force: true })
  })

  it('append + peek + readAndClear 正常流程', async () => {
    await appendTeamMailbox(workspaceRoot, 'mailbox-team', 'worker-mb', '消息1')
    await appendTeamMailbox(workspaceRoot, 'mailbox-team', 'worker-mb', '消息2')

    const peeked = await peekTeamMailbox(workspaceRoot, 'mailbox-team', 'worker-mb')
    expect(peeked).toEqual(['消息1', '消息2'])

    const read = await readAndClearTeamMailbox(workspaceRoot, 'mailbox-team', 'worker-mb')
    expect(read).toEqual(['消息1', '消息2'])

    const afterClear = await readAndClearTeamMailbox(workspaceRoot, 'mailbox-team', 'worker-mb')
    expect(afterClear).toEqual([])
  })

  it('T-09: 20 并发写入全部保留', async () => {
    const writes = Array.from({ length: 20 }, (_, i) =>
      appendTeamMailbox(workspaceRoot, 'mailbox-team', 'worker-mb', `并发消息-${i}`),
    )
    await Promise.all(writes)

    const messages = await readAndClearTeamMailbox(workspaceRoot, 'mailbox-team', 'worker-mb')
    expect(messages).toHaveLength(20)

    // 不关心顺序（文件锁保证原子性），但所有 20 条都应在
    for (let i = 0; i < 20; i++) {
      const found = messages.some((m) => m.includes(`并发消息-${i}`))
      expect(found).toBe(true)
    }
  })

  it('T-09: 100 并发写入无丢失', async () => {
    const writes = Array.from({ length: 100 }, (_, i) =>
      appendTeamMailbox(workspaceRoot, 'mailbox-team', 'worker-mb', `stress-${i}`),
    )
    await Promise.all(writes)

    const messages = await readAndClearTeamMailbox(workspaceRoot, 'mailbox-team', 'worker-mb')
    expect(messages).toHaveLength(100)
  })
})

// ================================================================
// TeamAutoLauncher 纯逻辑测试
// ================================================================

describe('teamAutoLauncher — 纯逻辑', () => {
  describe('buildTeamLaunchPlan', () => {
    it('T-03: coordinator 模式 phases 正确', () => {
      const plan = buildTeamLaunchPlan(
        mkTemplate('coordinator', [
          { agentType: 'Coordinator', role: 'coordinator' },
          { agentType: 'Explore', role: 'worker-a' },
          { agentType: 'Plan', role: 'worker-b' },
        ]),
        '协调任务',
      )
      expect(plan.phases).toEqual(['research', 'implementation'])
      expect(plan.members[0]?.agentType).toBe('Coordinator')
      expect(plan.members[0]?.phase).toBe('research')
    })

    it('T-08: 50 成员 parallel 模式 maxParallel = 50', () => {
      const members = Array.from({ length: 50 }, (_, i) => ({
        agentType: 'Explore',
        role: `worker-${i}`,
      }))
      const plan = buildTeamLaunchPlan(mkTemplate('parallel', members), '大规模')
      expect(plan.phases).toEqual(['research'])
      expect(plan.members).toHaveLength(50)
      expect(plan.maxParallel).toBe(50)
    })

    it('T-08: 50 成员 sequential 模式生成 50 个 phase', () => {
      const members = Array.from({ length: 50 }, (_, i) => ({
        agentType: 'Explore',
        role: `step-${i}`,
      }))
      const plan = buildTeamLaunchPlan(mkTemplate('sequential', members), '流水线')
      expect(plan.phases).toHaveLength(50)
      expect(plan.phases[0]).toBe('stage-0')
      expect(plan.phases[49]).toBe('stage-49')
      expect(plan.maxParallel).toBe(1)
    })

    it('T-11: sequential 生成连续 phases', () => {
      const plan = buildTeamLaunchPlan(
        mkTemplate('sequential', [
          { agentType: 'Explore' },
          { agentType: 'Plan' },
          { agentType: 'Verification' },
          { agentType: 'Debug' },
          { agentType: 'general-purpose' },
        ]),
        '五阶段流水线',
      )
      expect(plan.phases).toEqual([
        'stage-0',
        'stage-1',
        'stage-2',
        'stage-3',
        'stage-4',
      ])
      expect(plan.members.map((m) => m.phase)).toEqual([
        'stage-0',
        'stage-1',
        'stage-2',
        'stage-3',
        'stage-4',
      ])
    })

    it('T-11: parallelGroup 分组正确', () => {
      const plan = buildTeamLaunchPlan(
        mkTemplate('sequential', [
          { agentType: 'Explore', parallelGroup: 1 },
          { agentType: 'Plan', parallelGroup: 1 },
          { agentType: 'Verification', parallelGroup: 2 },
          { agentType: 'Debug', parallelGroup: 3 },
          { agentType: 'general-purpose', parallelGroup: 3 },
        ]),
        '分组流水线',
      )
      // 3 groups + 0 standalone → 3 phases
      expect(plan.phases).toEqual(['stage-0', 'stage-1', 'stage-2'])
      expect(plan.maxParallel).toBe(2) // group 1 and group 3 both have 2 members

      // stage-0: Explore + Plan
      const s0 = plan.members.filter((m) => m.phase === 'stage-0')
      expect(s0.map((m) => m.agentType).sort()).toEqual(['Explore', 'Plan'])

      // stage-1: Verification
      const s1 = plan.members.filter((m) => m.phase === 'stage-1')
      expect(s1.map((m) => m.agentType)).toEqual(['Verification'])

      // stage-2: Debug + general-purpose
      const s2 = plan.members.filter((m) => m.phase === 'stage-2')
      expect(s2.map((m) => m.agentType).sort()).toEqual(['Debug', 'general-purpose'])
    })

    it('T-18: swarm 降级为 parallel + downgradedFrom 标记', () => {
      const plan = buildTeamLaunchPlan(
        mkTemplate('swarm', [
          { agentType: 'Explore' },
          { agentType: 'Plan' },
          { agentType: 'Verification' },
        ]),
        'Swarm 任务',
      )
      expect(plan.coordination).toBe('parallel')
      expect(plan.downgradedFrom).toBe('swarm')
      expect(plan.phases).toEqual(['research'])
      expect(plan.maxParallel).toBe(3)
    })

    it('T-18: 成员 prompt 中包含降级提示', () => {
      const plan = buildTeamLaunchPlan(
        mkTemplate('swarm', [{ agentType: 'Explore', role: 'scout' }]),
        '降级测试',
      )
      expect(plan.members[0]?.prompt).toContain('downgraded from swarm')
    })

    it('solo 模式只有 1 个成员', () => {
      const plan = buildTeamLaunchPlan(
        mkTemplate('solo', [
          { agentType: 'Explore' },
          { agentType: 'Plan' }, // 被忽略
        ]),
        '单人任务',
      )
      expect(plan.members).toHaveLength(1)
      expect(plan.members[0]?.agentType).toBe('Explore')
      expect(plan.maxParallel).toBe(1)
    })

    it('空模板返回空 plan', () => {
      const plan = buildTeamLaunchPlan(mkTemplate('parallel', []), '空')
      expect(plan.members).toHaveLength(0)
      expect(plan.phases).toHaveLength(0)
    })

    it('空白 agentType 被跳过', () => {
      const plan = buildTeamLaunchPlan(
        mkTemplate('parallel', [
          { agentType: 'Explore' },
          { agentType: '   ' },
          { agentType: 'Plan' },
        ]),
        '跳过空白',
      )
      expect(plan.members).toHaveLength(2)
    })
  })

  describe('launchTeamFromTemplateAsync (桩注入)', () => {
    it('parallel 模式触发所有成员', async () => {
      const executor = vi.fn(
        async (req: PlannedTeamMemberLaunchRequest): Promise<SubAgentResult> =>
          stubResult(req.member.agentType, `done:${req.member.agentType}`),
      )

      const { completion, launchedCount, plan } = launchTeamFromTemplateAsync({
        template: mkTemplate('parallel', [
          { agentType: 'Explore', role: 'a' },
          { agentType: 'Plan', role: 'b' },
        ]),
        teamName: 'test-team',
        userGoal: '验证',
        workspaceRoot: '/tmp/test',
        executor,
      })

      expect(launchedCount).toBe(2)
      expect(plan.phases).toEqual(['research'])

      const results = await completion
      expect(results).toHaveLength(2)
      expect(results.map((r) => r.output).sort()).toEqual([
        'done:Explore',
        'done:Plan',
      ])
      expect(executor).toHaveBeenCalledTimes(2)
    })

    it('空模板 no-op', async () => {
      const executor = vi.fn()
      const { launchedCount, completion } = launchTeamFromTemplateAsync({
        template: mkTemplate('parallel', []),
        teamName: 'empty',
        userGoal: '',
        workspaceRoot: '/tmp/test',
        executor,
      })
      expect(launchedCount).toBe(0)
      await expect(completion).resolves.toEqual([])
      expect(executor).not.toHaveBeenCalled()
    })

    it('T-05: 不存在的 agentType 返回失败', async () => {
      // 不注入自定义 executor，使用默认 executor — 
      // 它会尝试 findAgentDefinition('nonexistent-type')
      // 这取决于运行时是否有此 agent。我们改为测试逻辑。
      // 模拟 executor 返回失败
      const executor = vi.fn(
        async (_req: PlannedTeamMemberLaunchRequest): Promise<SubAgentResult> => ({
          success: false,
          agentId: asAgentId(`fail-${Date.now()}`),
          agentType: 'unknown',
          output: 'Agent type not found',
          totalTokens: 0,
          totalDurationMs: 0,
          totalToolUses: 0,
        }),
      )

      const { completion } = launchTeamFromTemplateAsync({
        template: mkTemplate('parallel', [
          { agentType: 'nonexistent', role: 'fail' },
        ]),
        teamName: 'fail-team',
        userGoal: '应失败',
        workspaceRoot: '/tmp/test',
        executor,
      })

      const results = await completion
      expect(results).toHaveLength(1)
      expect(results[0]?.success).toBe(false)
    })
  })
})

// ================================================================
// Team Active Loop — PR-2..4 end-to-end integration scenarios
// (see docs/plans/team-active-loop.md, validation criteria #1..#6)
// ================================================================

describe('Team Active Loop — end-to-end', () => {
  const TEAM_NAME = 'active-loop'
  const LEAD_ID = `lead-${TEAM_NAME}`
  const TEAMMATE_NAME = 'researcher'

  let priorWorkspacePath: string | null
  let priorFlag: string | undefined

  beforeAll(async () => {
    priorWorkspacePath = getWorkspacePath()
    setWorkspacePath(workspaceRoot)
    await persistTeamFile(workspaceRoot, {
      teamName: TEAM_NAME,
      leadAgentId: LEAD_ID,
      members: [LEAD_ID, TEAMMATE_NAME],
      createdAt: Date.now(),
      mailbox: {},
    })
  })

  afterAll(() => {
    setWorkspacePath(priorWorkspacePath)
  })

  // Re-use the file-level afterEach (clearAllLocks + clearTeams) and add
  // per-test mailbox + task + flag isolation so the suite is order-stable.
  // Test-only env mutation; cleaned up below.
  // (The original file already declares an afterEach above; declaring a
  //  second one inside this nested describe stacks them deterministically.)
  beforeEach(async () => {
    priorFlag = process.env.POLE_TEAM_ACTIVE_LOOP
    process.env.POLE_TEAM_ACTIVE_LOOP = '1'
    await readAndClearTeamMailbox(workspaceRoot, TEAM_NAME, LEAD_ID)
    await readAndClearTeamMailbox(workspaceRoot, TEAM_NAME, TEAMMATE_NAME)
    taskManager.clear()
  })

  afterEach(() => {
    if (priorFlag === undefined) {
      delete process.env.POLE_TEAM_ACTIVE_LOOP
    } else {
      process.env.POLE_TEAM_ACTIVE_LOOP = priorFlag
    }
    taskManager.clear()
  })

  // Validation #1 (plan §9): teammate turn-end → lead mailbox has +1
  // idle_notification within the call window.
  it('writes idle_notification to lead mailbox at teammate turn end', async () => {
    const res = await sendTeammateIdleNotification({
      teammateAgentId: TEAMMATE_NAME,
      teammateName: TEAMMATE_NAME,
      teammateAgentType: 'researcher',
      leadAgentId: LEAD_ID,
      teamName: TEAM_NAME,
      reason: 'turn_complete',
      recentMessages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'SendMessage',
              input: { to: 'coder', summary: 'need auth helper' },
            },
          ],
        },
      ],
    })
    expect(res.delivered).toBe(true)

    const lines = await peekTeamMailbox(workspaceRoot, TEAM_NAME, LEAD_ID)
    expect(lines).toHaveLength(1)
    const proto = parseTeamInterAgentLine(lines[0])
    expect(proto?.kind).toBe('idle_notification')
    expect(proto?.detail).toBe('turn_complete')

    // peerDmSummary should be embedded in the envelope metadata.
    const envelope = JSON.parse(lines[0].replace(/^\[[^\]]+]\s+/, '')) as Record<string, unknown>
    const metadata = envelope.metadata as Record<string, unknown> | undefined
    expect(metadata?.peerDmSummary).toBe('[to coder] need auth helper')
  })

  // Validation #2: TaskUpdate(owner=X) → X mailbox has +1 task_assignment
  // with metadata.taskId matching the updated task.
  it('TaskUpdate(owner=X) writes task_assignment with matching metadata.taskId', async () => {
    const task = taskManager.create({ subject: 'audit S3', status: 'pending' })
    const ctx = {
      agentId: asAgentId(LEAD_ID),
      sessionAgentType: 'team-lead',
      teamId: TEAM_NAME,
      systemPrompt: '',
      messages: [],
      signal: new AbortController().signal,
      config: { id: 'anthropic' as const, name: 'Anthropic', apiKey: '' },
      model: 'claude-sonnet',
    } satisfies AgentContext

    await runWithAgentContextAsync(ctx, async () => {
      const result = await taskUpdateTool.execute(
        { taskId: task.taskId, owner: TEAMMATE_NAME },
        undefined as never,
      )
      expect(result.success).toBe(true)
    })

    const lines = await peekTeamMailbox(workspaceRoot, TEAM_NAME, TEAMMATE_NAME)
    expect(lines).toHaveLength(1)
    const proto = parseTeamInterAgentLine(lines[0])
    expect(proto?.kind).toBe('task_assignment')
    expect(proto?.detail).toBe(task.taskId)

    // Inner protocol metadata.taskId must match the updated task id.
    const envelope = JSON.parse(lines[0].replace(/^\[[^\]]+]\s+/, '')) as Record<string, unknown>
    const inner = JSON.parse(envelope.payload as string) as Record<string, unknown>
    const innerMeta = inner.metadata as Record<string, unknown> | undefined
    expect(innerMeta?.taskId).toBe(task.taskId)
    expect(innerMeta?.taskSubject).toBe('audit S3')
  })

  // Validation #3: idle teammate with unowned pending task → claim
  // transitions the task to in_progress with the teammate as owner.
  it('tryClaimNextTask claims an unowned pending task and updates state', () => {
    const t = taskManager.create({ subject: 'wire auth', status: 'pending' })
    const claim = tryClaimNextTask({ teammateName: TEAMMATE_NAME })
    expect(claim?.taskId).toBe(t.taskId)
    const updated = taskManager.getTask(t.taskId)
    expect(updated?.status).toBe('in_progress')
    expect(updated?.owner).toBe(TEAMMATE_NAME)
  })

  // Validation #6: consecutive-claim cap enforces idle even when work is
  // available — protects against task-list loops.
  it('tryClaimNextTask returns null once the consecutive-claim cap is hit', () => {
    // Plenty of work available.
    for (let i = 0; i < 12; i++) {
      taskManager.create({ subject: `t-${i}`, status: 'pending' })
    }
    // alreadyClaimedThisRun >= cap → null
    const blocked = tryClaimNextTask({
      teammateName: TEAMMATE_NAME,
      alreadyClaimedThisRun: DEFAULT_MAX_CONSECUTIVE_CLAIMS,
    })
    expect(blocked).toBeNull()
    // One below the cap → still claims.
    const ok = tryClaimNextTask({
      teammateName: TEAMMATE_NAME,
      alreadyClaimedThisRun: DEFAULT_MAX_CONSECUTIVE_CLAIMS - 1,
    })
    expect(ok).not.toBeNull()
  })

  // Validation #5: lead inbox draining yields a <team-inbox> block that
  // mixes idle_notification + task_completion entries.
  it('readAndRenderTeamInbox renders a <team-inbox> block from queued envelopes', async () => {
    // 1) Idle from researcher (with peer-dm summary).
    await sendTeammateIdleNotification({
      teammateAgentId: TEAMMATE_NAME,
      teammateName: TEAMMATE_NAME,
      leadAgentId: LEAD_ID,
      teamName: TEAM_NAME,
      reason: 'turn_complete',
      recentMessages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'SendMessage',
              input: { to: 'coder', summary: 'ack' },
            },
          ],
        },
      ],
    })
    // 2) task_assignment (lead just dispatched). Note this lands in the
    //    teammate's box, NOT the lead's — won't appear in our render.
    await sendTaskAssignmentNotification({
      toOwner: TEAMMATE_NAME,
      taskId: 'task-99',
      taskSubject: 'wire auth',
      assignedBy: LEAD_ID,
      teamName: TEAM_NAME,
    })

    const xml = await readAndRenderTeamInbox({
      workspaceRoot,
      teamName: TEAM_NAME,
      leadAgentId: LEAD_ID,
    })
    expect(xml).not.toBeNull()
    expect(xml).toContain('<team-inbox>')
    expect(xml).toContain('kind="idle_notification"')
    expect(xml).toContain('<peer-dm-summary>[to coder] ack</peer-dm-summary>')

    // After draining the lead's inbox is empty (consumptive read).
    const post = await peekTeamMailbox(workspaceRoot, TEAM_NAME, LEAD_ID)
    expect(post).toEqual([])
  })

  // Validation #7: POLE_TEAM_ACTIVE_LOOP explicitly disabled → no
  // mailbox writes, no claim attempts. (S3: the flag is ON by default
  // for upstream alignment, so testing the OFF path requires an
  // explicit '0' rather than `delete`.)
  it('with the feature flag explicitly disabled, all active-loop side effects are skipped', async () => {
    process.env.POLE_TEAM_ACTIVE_LOOP = '0'

    // (a) idle notifier returns flag_off
    const idleRes = await sendTeammateIdleNotification({
      teammateAgentId: TEAMMATE_NAME,
      leadAgentId: LEAD_ID,
      teamName: TEAM_NAME,
      reason: 'turn_complete',
    })
    expect(idleRes.delivered).toBe(false)
    expect(idleRes.skipReason).toBe('flag_off')

    // (b) assignment notifier returns flag_off
    const assignRes = await sendTaskAssignmentNotification({
      toOwner: TEAMMATE_NAME,
      taskId: 'task-1',
      teamName: TEAM_NAME,
    })
    expect(assignRes.delivered).toBe(false)
    expect(assignRes.skipReason).toBe('flag_off')

    // (c) TaskUpdate(owner=X) still updates the task but writes NO mailbox.
    const t = taskManager.create({ subject: 'silent', status: 'pending' })
    const ctx = {
      agentId: asAgentId(LEAD_ID),
      sessionAgentType: 'team-lead',
      teamId: TEAM_NAME,
      systemPrompt: '',
      messages: [],
      signal: new AbortController().signal,
      config: { id: 'anthropic' as const, name: 'Anthropic', apiKey: '' },
      model: 'claude-sonnet',
    } satisfies AgentContext
    await runWithAgentContextAsync(ctx, async () => {
      const result = await taskUpdateTool.execute(
        { taskId: t.taskId, owner: TEAMMATE_NAME },
        undefined as never,
      )
      expect(result.success).toBe(true)
    })
    const lines = await peekTeamMailbox(workspaceRoot, TEAM_NAME, TEAMMATE_NAME)
    expect(lines).toEqual([])
  })

  // Validation: TaskUpdate(owner) on a NON-team context (no agent ctx or
  // ctx without teamId) is a no-op for the active loop — protects the
  // main chat path from accidental mailbox writes when no team exists.
  it('TaskUpdate(owner) without a team context does not write task_assignment', async () => {
    const t = taskManager.create({ subject: 'no-team', status: 'pending' })
    // Run with ALS context that has NO teamId.
    const ctx = {
      agentId: asAgentId('main'),
      systemPrompt: '',
      messages: [],
      signal: new AbortController().signal,
      config: { id: 'anthropic' as const, name: 'Anthropic', apiKey: '' },
      model: 'claude-sonnet',
    } satisfies AgentContext
    await runWithAgentContextAsync(ctx, async () => {
      const result = await taskUpdateTool.execute(
        { taskId: t.taskId, owner: TEAMMATE_NAME },
        undefined as never,
      )
      expect(result.success).toBe(true)
    })
    const lines = await peekTeamMailbox(workspaceRoot, TEAM_NAME, TEAMMATE_NAME)
    expect(lines).toEqual([])
  })
})
