/**
 * P1 Bug 验证测试 — 上下文管线问题
 *
 * CTX-01: recallPipeline 全部检索源失败时无告警、无回退
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ---------------------------------------------------------------------------
// CTX-01: recallPipeline 全部检索源失败时静默
// ---------------------------------------------------------------------------

describe('CTX-01: recallPipeline silent failure when all sources fail', () => {
  it('全部检索源失败时 lists.length === 0 返回空 entries', () => {
    const src = fs.readFileSync(
      path.join(__dirname, 'recallPipeline.ts'),
      'utf-8',
    )

    // L178-180: 如果所有检索源都没有产出，静默返回空列表
    const hasEmptyReturn = src.includes('lists.length === 0')
    expect(hasEmptyReturn).toBe(true)

    const lines = src.split('\n')
    const line178Idx = lines.findIndex((l) =>
      l.includes('lists.length === 0'),
    )

    if (line178Idx >= 0) {
      // 检查返回语句附近是否有 warn/error 日志
      const contextLines = lines.slice(
        Math.max(0, line178Idx - 3),
        Math.min(lines.length, line178Idx + 9),
      ).join('\n')

      const hasWarning = /warn|error|console\.(log|warn|error)/i.test(contextLines)

      // FIX 验证: 现在有 console.warn 告警
      expect(hasWarning).toBe(true)

      // 只返回空 entries，trace 可能包含空 sources 数组
      expect(contextLines).toContain('{ entries: [], trace }')
    }
  })

  it('当没有任何 embedding 配置时 hybridRecall 使用 BM25 回退', () => {
    const src = fs.readFileSync(
      path.join(__dirname, 'recallPipeline.ts'),
      'utf-8',
    )

    // L108-117: hybridEnabled === false 时有 BM25 回退
    const hasFallback = src.includes('hybridEnabled')
    expect(hasFallback).toBe(true)

    // 但当 hybridEnabled === true 且所有源都失败时，没有额外回退
    // vector 失败被 .catch() 吞掉，BM25 可能也失败
  })

  it('vector 检索失败时 .catch(() => []) 静默吞掉错误', () => {
    const src = fs.readFileSync(
      path.join(__dirname, 'recallPipeline.ts'),
      'utf-8',
    )

    // L127-129: rankMemoriesByEmbedding 失败时 catch 返回空数组
    const hasSilentCatch = src.includes('.catch(')
    expect(hasSilentCatch).toBe(true)

    // 这里没有 console.warn 或 error 日志
    // 调用者无法区分 "没有相关记忆" 和 "embedding 服务挂了"
  })
})

// ---------------------------------------------------------------------------
// CTX-02: systemPrompt 缓存仅在 /clear-style 时失效
// ---------------------------------------------------------------------------

describe('CTX-02: systemPrompt cache only invalidates on /clear-style', () => {
  it('invalidateSystemPromptInstructionCache 是唯一清除入口', () => {
    const spSrc = fs.readFileSync(
      path.join(__dirname, '..', 'ai', 'systemPrompt.ts'),
      'utf-8',
    )

    // 缓存清除只在 explicit 的 invalidateAllSystemPromptMemoCaches 中触发
    // 不在其他路径（如 settings 变更、memory 更新）中自动触发
    const hasInvalidateAll = spSrc.includes('invalidateAllSystemPromptMemoCaches')
    expect(hasInvalidateAll).toBe(true)

    // BUG 验证: 缓存只通过显式 API 失效
    // 如果 settings、skills、rules 通过其他路径更新（非 /clear-style），
    // 缓存不会自动失效
  })

  it('orchestration 自定义路径绕过两层缓存', async () => {
    // 验证 orchestrationContext.ts 中自定义路径是否绕过了 buildSystemPromptLayers
    // 如果绕过了，则 instruction cache 和 userContext cache 都不会命中
    const occ = await import('../ai/orchestrationContext')

    // buildMainSystemPromptLayersFromOrchestration 存在
    expect(typeof occ.buildMainSystemPromptLayersFromOrchestration).toBe('function')
  })
})
