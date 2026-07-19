/**
 * Tests for `teamAutoLauncher` — the planner + dispatcher that turns a
 * `TeamTemplate` from a Bundle into a concrete fan-out on
 * `runCoordinatorWorkflow`.
 *
 * Two layers of coverage:
 *   1. `buildTeamLaunchPlan` is pure and tested directly for each coordination
 *      mode (solo / parallel / sequential / sequential-with-parallel-group /
 *      coordinator / swarm → downgrade).
 *   2. `launchTeamFromTemplateAsync` is exercised with an **injected stub
 *      executor** so we can assert the orchestrator actually fires the
 *      expected members in the expected phase order without ever talking to
 *      a real LLM or sub-agent runner.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  buildTeamLaunchPlan,
  launchTeamFromTemplateAsync,
  type PlannedTeamMemberLaunchRequest,
} from './teamAutoLauncher'
import type { TeamTemplate, TeamCoordination } from './bundles/types'
import type { SubAgentResult } from './types'
import { asAgentId } from '../tools/ids'

function mkTemplate(
  coordination: TeamCoordination,
  members: Array<{ agentType: string; role?: string; parallelGroup?: number }>,
): TeamTemplate {
  return {
    id: 'tpl-test',
    name: 'Test Team',
    description: 'unit-test fixture',
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

describe('buildTeamLaunchPlan', () => {
  it('solo uses only the first member in a single `research` phase', () => {
    const plan = buildTeamLaunchPlan(
      mkTemplate('solo', [
        { agentType: 'Explore', role: 'lead' },
        { agentType: 'Plan', role: 'helper' },
      ]),
      'Find the bug',
    )
    expect(plan.coordination).toBe('solo')
    expect(plan.phases).toEqual(['research'])
    expect(plan.members).toHaveLength(1)
    expect(plan.members[0]?.agentType).toBe('Explore')
    expect(plan.maxParallel).toBe(1)
  })

  it('parallel puts every member in the same `research` phase', () => {
    const plan = buildTeamLaunchPlan(
      mkTemplate('parallel', [
        { agentType: 'Explore', role: 'a' },
        { agentType: 'Explore', role: 'b' },
        { agentType: 'Plan', role: 'c' },
      ]),
      'Parallel recon',
    )
    expect(plan.phases).toEqual(['research'])
    expect(plan.members).toHaveLength(3)
    for (const m of plan.members) expect(m.phase).toBe('research')
    expect(plan.maxParallel).toBe(3)
  })

  it('sequential without parallelGroup creates one phase per member', () => {
    const plan = buildTeamLaunchPlan(
      mkTemplate('sequential', [
        { agentType: 'Explore' },
        { agentType: 'Plan' },
        { agentType: 'Verification' },
      ]),
      'Pipeline',
    )
    expect(plan.phases).toEqual(['stage-0', 'stage-1', 'stage-2'])
    expect(plan.members.map((m) => m.phase)).toEqual(['stage-0', 'stage-1', 'stage-2'])
    expect(plan.maxParallel).toBe(1)
  })

  it('sequential with parallelGroup packs same-group members into one phase', () => {
    const plan = buildTeamLaunchPlan(
      mkTemplate('sequential', [
        { agentType: 'Explore', parallelGroup: 1 },
        { agentType: 'Plan', parallelGroup: 1 },
        { agentType: 'Verification', parallelGroup: 2 },
      ]),
      'Grouped pipeline',
    )
    expect(plan.phases).toEqual(['stage-0', 'stage-1'])
    // Group 1 → stage-0 (two members, parallel); group 2 → stage-1 (one member).
    const byPhase = plan.members.reduce<Record<string, string[]>>((acc, m) => {
      const key = m.phase
      acc[key] = [...(acc[key] ?? []), m.agentType]
      return acc
    }, {})
    expect(byPhase['stage-0']?.sort()).toEqual(['Explore', 'Plan'])
    expect(byPhase['stage-1']).toEqual(['Verification'])
    expect(plan.maxParallel).toBe(2)
  })

  it('coordinator runs the coordinator alone in phase 1, peers parallel in phase 2', () => {
    const plan = buildTeamLaunchPlan(
      mkTemplate('coordinator', [
        { agentType: 'Explore', role: 'worker-a' },
        { agentType: 'Coordinator', role: 'coordinator' },
        { agentType: 'Plan', role: 'worker-b' },
      ]),
      'Hand-off',
    )
    expect(plan.phases).toEqual(['research', 'implementation'])
    expect(plan.members[0]?.agentType).toBe('Coordinator')
    expect(plan.members[0]?.phase).toBe('research')
    const impl = plan.members.filter((m) => m.phase === 'implementation')
    expect(impl.map((m) => m.agentType).sort()).toEqual(['Explore', 'Plan'])
    expect(plan.maxParallel).toBe(2)
  })

  it('coordinator without an explicit `role:"coordinator"` falls back to the first member as lead', () => {
    const plan = buildTeamLaunchPlan(
      mkTemplate('coordinator', [
        { agentType: 'Explore' },
        { agentType: 'Plan' },
      ]),
      'Implicit lead',
    )
    expect(plan.members[0]?.agentType).toBe('Explore')
    expect(plan.members[0]?.phase).toBe('research')
    expect(plan.members[1]?.agentType).toBe('Plan')
    expect(plan.members[1]?.phase).toBe('implementation')
  })

  it('swarm downgrades to parallel with a note', () => {
    const plan = buildTeamLaunchPlan(
      mkTemplate('swarm', [
        { agentType: 'Explore' },
        { agentType: 'Plan' },
      ]),
      'Swarm',
    )
    expect(plan.coordination).toBe('parallel')
    expect(plan.downgradedFrom).toBe('swarm')
    expect(plan.phases).toEqual(['research'])
    expect(plan.maxParallel).toBe(2)
  })

  it('empty-member template yields an empty plan (no phases, nothing to run)', () => {
    const plan = buildTeamLaunchPlan(mkTemplate('parallel', []), 'Nothing')
    expect(plan.members).toHaveLength(0)
    expect(plan.phases).toHaveLength(0)
  })

  it('skips members whose agentType is empty or whitespace', () => {
    const plan = buildTeamLaunchPlan(
      mkTemplate('parallel', [
        { agentType: 'Explore' },
        { agentType: '   ' },
        { agentType: 'Plan' },
      ]),
      'Skip blanks',
    )
    expect(plan.members).toHaveLength(2)
    expect(plan.members.map((m) => m.agentType)).toEqual(['Explore', 'Plan'])
  })

  it('embeds the user goal in every member prompt so sub-agents share context', () => {
    const plan = buildTeamLaunchPlan(
      mkTemplate('parallel', [
        { agentType: 'Explore', role: 'a' },
        { agentType: 'Plan', role: 'b' },
      ]),
      'Find incident root cause in auth service',
    )
    for (const m of plan.members) {
      expect(m.prompt).toContain('Find incident root cause in auth service')
      expect(m.prompt).toContain('Test Team')
    }
    // Each member sees peers minus themselves.
    expect(plan.members[0]?.prompt).toContain('- b')
    expect(plan.members[0]?.prompt).not.toMatch(/^- a$/m)
    expect(plan.members[1]?.prompt).toContain('- a')
  })

  // Regression — see comment in `mkPrompt` (teamAutoLauncher.ts:177-187).
  // Read-only agents (`Explore` / `Plan` / `Verification`) have
  // `SendMessage` + `TeamCreate` in their disallowedTools and `TeamStatus`
  // is not in `ASYNC_AGENT_ALLOWED_TOOLS` either. Previously the prompt
  // told them to call those tools anyway, so the model would either
  // skip the instruction (best case) or attempt the unknown-tool retry
  // loop (worst case, observed as permanent "booting" on the
  // research-plan-verify first phase).
  it('omits SendMessage/TeamStatus instructions for read-only members (Explore/Plan/Verification)', () => {
    const plan = buildTeamLaunchPlan(
      mkTemplate('sequential', [
        { agentType: 'Explore', role: 'researcher' },
        { agentType: 'Plan', role: 'planner' },
        { agentType: 'Verification', role: 'verifier' },
      ]),
      'Investigate the auth bug',
    )
    for (const m of plan.members) {
      expect(m.prompt).not.toContain('SendMessage(')
      expect(m.prompt).not.toContain('TeamStatus(')
      // The read-only share-progress branch explicitly tells the model
      // why those tools are absent so it doesn't reinvent them.
      expect(m.prompt).toContain('You do not have SendMessage / TeamStatus / TeamCreate')
      expect(m.prompt).toContain('TaskOutput')
    }
  })

  it('keeps SendMessage/TeamStatus instructions for non-read-only members (Coordinator/general-purpose)', () => {
    const plan = buildTeamLaunchPlan(
      mkTemplate('coordinator', [
        { agentType: 'Coordinator', role: 'coordinator' },
        { agentType: 'general-purpose', role: 'worker' },
      ]),
      'Refactor the auth module',
      'live-team-key',
    )
    for (const m of plan.members) {
      expect(m.prompt).toContain('SendMessage(to: "team:live-team-key"')
      expect(m.prompt).toContain('TeamStatus(team_name: "live-team-key"')
    }
  })

  it('mixed team prompts respect per-member read-only status', () => {
    const plan = buildTeamLaunchPlan(
      mkTemplate('coordinator', [
        { agentType: 'Coordinator', role: 'coordinator' },
        { agentType: 'Explore', role: 'researcher' },
        { agentType: 'general-purpose', role: 'worker' },
      ]),
      'Audit and patch',
      'mixed-team',
    )
    const byType = new Map<string, string>()
    for (const m of plan.members) byType.set(m.agentType, m.prompt)
    expect(byType.get('Coordinator')!).toContain('SendMessage(')
    expect(byType.get('general-purpose')!).toContain('SendMessage(')
    expect(byType.get('Explore')!).not.toContain('SendMessage(')
  })
})

describe('launchTeamFromTemplateAsync (with stub executor)', () => {
  it('fires every planned member through the injected executor and completes the promise', async () => {
    const executor = vi.fn(
      async (req: PlannedTeamMemberLaunchRequest): Promise<SubAgentResult> =>
        stubResult(req.member.agentType, `done:${req.member.agentType}`),
    )

    const { completion, launchedCount, plan } = launchTeamFromTemplateAsync({
      template: mkTemplate('parallel', [
        { agentType: 'Explore', role: 'a' },
        { agentType: 'Plan', role: 'b' },
      ]),
      teamName: 'demo-team',
      userGoal: 'Check it works',
      workspaceRoot: '/tmp/ws',
      executor,
    })

    expect(launchedCount).toBe(2)
    expect(plan.phases).toEqual(['research'])

    const results = await completion
    expect(results).toHaveLength(2)
    expect(results.map((r) => r.output).sort()).toEqual(['done:Explore', 'done:Plan'])
    expect(executor).toHaveBeenCalledTimes(2)

    // Each executor call gets the same teamName + workspace context.
    for (const [reqArg] of executor.mock.calls) {
      expect(reqArg.teamName).toBe('demo-team')
      expect(reqArg.workspaceRoot).toBe('/tmp/ws')
    }
  })

  it('passes TeamCreate lead id to the first planned member', async () => {
    const leadAgentId = asAgentId('lead-demo-team')
    const executor = vi.fn(
      async (req: PlannedTeamMemberLaunchRequest): Promise<SubAgentResult> =>
        stubResult(req.agentIdOverride ?? req.member.agentType, `done:${req.member.agentType}`),
    )

    const { completion } = launchTeamFromTemplateAsync({
      template: mkTemplate('coordinator', [
        { agentType: 'Coordinator', role: 'coordinator' },
        { agentType: 'Explore', role: 'researcher' },
      ]),
      teamName: 'demo-team',
      userGoal: 'Explore the app',
      workspaceRoot: '/tmp/ws',
      leadAgentId,
      executor,
    })

    await completion

    expect(executor).toHaveBeenCalledTimes(2)
    expect(executor.mock.calls[0]?.[0].agentIdOverride).toBe(leadAgentId)
    expect(executor.mock.calls[1]?.[0].agentIdOverride).toBeUndefined()
  })

  it('sequential ordering: stage-1 does not start before stage-0 finishes', async () => {
    const startOrder: string[] = []
    const endOrder: string[] = []

    // Executor records start/end order; stage-0 has a longer "think" time
    // than stage-1 so if they ran in parallel we'd observe stage-1 finishing
    // before stage-0 — the coordinator is supposed to prevent that.
    const executor = async (req: PlannedTeamMemberLaunchRequest): Promise<SubAgentResult> => {
      const tag = req.member.agentType
      startOrder.push(tag)
      await new Promise<void>((resolve) => setTimeout(resolve, tag === 'Explore' ? 40 : 5))
      endOrder.push(tag)
      return stubResult(tag)
    }

    const { completion } = launchTeamFromTemplateAsync({
      template: mkTemplate('sequential', [
        { agentType: 'Explore' },
        { agentType: 'Plan' },
      ]),
      teamName: 'seq-team',
      userGoal: 'Strict order',
      workspaceRoot: '/tmp/ws',
      executor,
    })
    await completion

    // Stage-0 (Explore) must finish before Stage-1 (Plan) starts.
    expect(startOrder).toEqual(['Explore', 'Plan'])
    expect(endOrder).toEqual(['Explore', 'Plan'])
  })

  it('aborts all pending members when the parent abort signal fires', async () => {
    const abortController = new AbortController()
    let cancelledInExecutor = 0

    const executor = async (
      req: PlannedTeamMemberLaunchRequest,
    ): Promise<SubAgentResult> => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 200)
        req.abortSignal.addEventListener(
          'abort',
          () => {
            cancelledInExecutor++
            clearTimeout(timer)
            // Resolve rather than reject so the coordinator records a result.
            resolve()
          },
          { once: true },
        )
        // Reject guard (never hit normally but TS needs the reference).
        void reject
      })
      return stubResult(req.member.agentType, req.abortSignal.aborted ? 'aborted' : 'ran')
    }

    const { completion } = launchTeamFromTemplateAsync({
      template: mkTemplate('parallel', [
        { agentType: 'Explore' },
        { agentType: 'Plan' },
      ]),
      teamName: 'abort-team',
      userGoal: 'Will be cancelled',
      workspaceRoot: '/tmp/ws',
      parentAbortSignal: abortController.signal,
      executor,
    })

    // Cancel right after dispatch.
    setTimeout(() => abortController.abort(), 10)

    const results = await completion
    expect(results).toHaveLength(2)
    expect(cancelledInExecutor).toBe(2)
    for (const r of results) expect(r.output).toBe('aborted')
  })

  it('no-op when the template has no valid members', async () => {
    const executor = vi.fn()
    const { launchedCount, completion, plan } = launchTeamFromTemplateAsync({
      template: mkTemplate('parallel', []),
      teamName: 'empty-team',
      userGoal: '',
      workspaceRoot: '/tmp/ws',
      executor,
    })
    expect(launchedCount).toBe(0)
    expect(plan.members).toHaveLength(0)
    await expect(completion).resolves.toEqual([])
    expect(executor).not.toHaveBeenCalled()
  })
})
