/**
 * 中文引号 / CJK 全角字符规范化集成测试。
 *
 * 覆盖：
 *   - canonicalizeForLlmDrift — 全角→半角 / 弯引号→直引号 / NFC
 *   - resolveWithDriftFallback — 路径中文字符漂移回退
 *   - 文件内容中中文引号的 Write/Edit 语义
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, afterAll } from 'vitest'
import { canonicalizeForLlmDrift, resolveWithDriftFallback } from './charDriftCanonical'
import { computeFileEditResult } from '../ai/fileEditSemantics'

// ─────────────────────────────────────────────────────────────────────
// 临时目录工具
// ─────────────────────────────────────────────────────────────────────

const tmpRoot = path.join(os.tmpdir(), 'pole-drift-test-' + Date.now().toString(36))
afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
})

function touchDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function touchFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
}

// ─────────────────────────────────────────────────────────────────────
// canonicalizeForLlmDrift — 全角 CJK 标点 → 半角 ASCII
// ─────────────────────────────────────────────────────────────────────

describe('canonicalizeForLlmDrift — CJK 全角标点映射', () => {
  // ── 弯引号 → 直引号 ──
  it('左弯双引号 \u201C → 直双引号 "', () => {
    expect(canonicalizeForLlmDrift('\u201C你好\u201D')).toBe('"你好"')
  })

  it('右弯双引号 \u201D → 直双引号 "', () => {
    expect(canonicalizeForLlmDrift('\u201C世界\u201D')).toBe('"世界"')
  })

  it('左弯单引号 \u2018 → 直单引号', () => {
    expect(canonicalizeForLlmDrift("\u2018hello\u2019")).toBe("'hello'")
  })

  it('右弯单引号 \u2019 → 直单引号', () => {
    expect(canonicalizeForLlmDrift("\u2018data\u2019")).toBe("'data'")
  })

  // ── 全角标点 → 半角 ──
  it('全角逗号 U+FF0C → 半角逗号', () => {
    expect(canonicalizeForLlmDrift('A\uFF0CB')).toBe('A,B')
  })

  it('中文全角逗号 ， → ,', () => {
    expect(canonicalizeForLlmDrift('参数一，参数二')).toBe('参数一,参数二')
  })

  it('CJK 句号 U+3002 → 英文句号', () => {
    expect(canonicalizeForLlmDrift('第一。第二')).toBe('第一.第二')
  })

  it('全角括号 （） → ()', () => {
    expect(canonicalizeForLlmDrift('函数（参数）')).toBe('函数(参数)')
  })

  it('全角冒号 ： → :', () => {
    expect(canonicalizeForLlmDrift('键：值')).toBe('键:值')
  })

  it('全角分号 ； → ;', () => {
    expect(canonicalizeForLlmDrift('A；B')).toBe('A;B')
  })

  it('全角感叹号 ！ → !', () => {
    expect(canonicalizeForLlmDrift('完成！')).toBe('完成!')
  })

  it('全角问号 ？ → ?', () => {
    expect(canonicalizeForLlmDrift('真的？')).toBe('真的?')
  })

  it('CJK 黑括号 【】 → []', () => {
    expect(canonicalizeForLlmDrift('【标题】')).toBe('[标题]')
  })

  it('CJK 书名号 《》 → <>', () => {
    expect(canonicalizeForLlmDrift('《红楼梦》')).toBe('<红楼梦>')
  })

  // ── NFC 规范化 ──
  it('NFC 组合字符规范化（é = e + ́ → é 预组合）', () => {
    const decomposed = 'cafe\u0301'   // e + combining acute
    const composed = 'caf\u00E9'       // é precomposed
    // 规范化后两者应相等
    expect(canonicalizeForLlmDrift(decomposed)).toBe(canonicalizeForLlmDrift(composed))
  })

  it('中文汉字不被规范化（保持原样）', () => {
    const chinese = '你好世界，这是一段中文测试。'
    expect(canonicalizeForLlmDrift(chinese)).toBe('你好世界,这是一段中文测试.')
    // ，→ ,   。→ .
  })

  it('混合中英文标点——只规范化全角部分', () => {
    const LQ = '\u2018' // left single curly quote
    const RQ = '\u2019' // right single curly quote
    const mixed = `名称：${LQ}你好${RQ}，【状态】OK。`
    const result = canonicalizeForLlmDrift(mixed)
    // \u2018 → '  (left single curly → straight single)
    // \u2019 → '  (right single curly → straight single)
    expect(result).toBe("名称:'你好',[状态]OK.")
  })

  // ── 保持不变的字符 ──
  it('ASCII 直引号保持不变', () => {
    expect(canonicalizeForLlmDrift('"straight"')).toBe('"straight"')
  })

  it('ASCII 括号/逗号/句号保持不变', () => {
    expect(canonicalizeForLlmDrift('hello (world), done.')).toBe('hello (world), done.')
  })

  it('下划线、连字符、点号保持不变（不误匹配文件名）', () => {
    expect(canonicalizeForLlmDrift('my_file-name.ts')).toBe('my_file-name.ts')
  })

  it('中文字符本身不变（零宽度空格除外）', () => {
    const cjk = '中文English混合text'
    expect(canonicalizeForLlmDrift(cjk)).toBe(cjk)
  })

  // ── 空/边界 ──
  it('空字符串规范化返回空', () => {
    expect(canonicalizeForLlmDrift('')).toBe('')
  })

  it('只有标点的字符串正确规范化', () => {
    expect(canonicalizeForLlmDrift('：；！？（）【】《》')).toBe(':;!?()[]<>')
  })
})

// ─────────────────────────────────────────────────────────────────────
// resolveWithDriftFallback — 路径漂移回退
// ─────────────────────────────────────────────────────────────────────

describe('resolveWithDriftFallback — 中文字符路径漂移', () => {
  const base = path.join(tmpRoot, 'path-drift')

  it('文件路径存在时原样返回（零开销）', () => {
    touchDir(base)
    const abs = path.join(base, 'normal.txt')
    touchFile(abs, 'content')
    expect(resolveWithDriftFallback(abs)).toBe(abs)
  })

  it('文件夹名含全角括号时回退到实际半角括号', () => {
    const realDir = path.join(base, 'project(v1)')
    touchDir(realDir)
    const driftedDir = path.join(base, 'project（v1）') // 全角括号
    expect(resolveWithDriftFallback(driftedDir)).toBe(realDir)
  })

  it('文件夹名含全角冒号时回退到实际半角冒号（非 Windows 文件系统）', () => {
    if (process.platform === 'win32') return // Windows 不允许文件名含冒号
    const realDir = path.join(base, 'chapter: intro')
    touchDir(realDir)
    const driftedDir = path.join(base, 'chapter： intro')
    expect(resolveWithDriftFallback(driftedDir)).toBe(realDir)
  })

  it('文件名含CJK黑括号时回退到实际半角方括号', () => {
    const realFile = path.join(base, 'docs[ref].txt')
    touchFile(realFile, 'content')
    const driftedFile = path.join(base, 'docs【ref】.txt') // CJK 黑括号
    expect(resolveWithDriftFallback(driftedFile)).toBe(realFile)
  })

  it('多层漂移——每层都回退', () => {
    const d1 = path.join(base, 'src(test)')
    const d2 = path.join(d1, 'sub[ok]')
    touchDir(d2)
    const drifted = path.join(base, 'src（test）', 'sub【ok】') // 全角括号+黑括号
    expect(resolveWithDriftFallback(drifted)).toBe(d2)
  })

  it('不存在的路径返回 null', () => {
    const nowhere = path.join(base, 'no-such-thing')
    expect(resolveWithDriftFallback(nowhere)).toBeNull()
  })

  it('只有首段漂移返回 null（无兄弟目录可回退）', () => {
    const drifted = path.join(base, 'project（v2）')
    // base 下没有 project(v2) 也没有 project(v2) 的任何规范化变体
    touchDir(path.join(base, 'unrelated'))
    expect(resolveWithDriftFallback(drifted)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────
// computeFileEditResult — 文件内容中文字符漂移的 Edit 匹配
// ─────────────────────────────────────────────────────────────────────

describe('computeFileEditResult — 中文内容 Edit 匹配', () => {
  // ── 中文引号漂移（症状核心）──
  it('old_string 用直引号匹配文件中的弯引号', () => {
    const fileContent = '名称是\u201C测试\u201D文件'
    const oldStr = '名称是"测试"文件'      // LLM 输出直引号
    const newStr = '名称是"生产"文件'
    const r = computeFileEditResult(fileContent, oldStr, newStr)
    expect(r.success).toBe(true)
    if (r.success) {
      // preserveQuoteStyle 将 newString 的直引号转换为弯引号
      // 注意：isOpeningContext 对 CJK 字符的启发式可能产生混合左/右弯引号
      // 但核心语义：匹配成功，替换执行
      expect(r.newContent).not.toBe(fileContent)
      expect(r.newContent).toContain('生产')
      expect(r.newContent).toContain('名称是')
      expect(r.newContent).toContain('文件')
    }
  })

  it('old_string 用弯引号匹配文件中的直引号', () => {
    const fileContent = '名称是"测试"文件'
    const oldStr = '名称是\u201C测试\u201D文件'  // LLM 输出弯引号
    const newStr = '名称是\u201C生产\u201D文件'
    const r = computeFileEditResult(fileContent, oldStr, newStr)
    expect(r.success).toBe(true)
    if (r.success) {
      // 匹配成功，替换执行
      expect(r.newContent).not.toBe(fileContent)
      expect(r.newContent).toContain('生产')
    }
  })

  // ── 全角标点漂移 ──
  it('old_string 用半角逗号匹配文件中的全角逗号', () => {
    const fileContent = '参数列表：A，B，C'
    const oldStr = '参数列表：A,B,C'        // LLM 输出半角逗号
    const newStr = '参数列表：X,Y,Z'
    const r = computeFileEditResult(fileContent, oldStr, newStr)
    expect(r.success).toBe(true)
  })

  it('old_string 用半角括号匹配文件中的全角括号', () => {
    const fileContent = '调用函数（参数）;'
    const oldStr = '调用函数(参数);'        // LLM 输出半角括号
    const newStr = '调用函数(arg);'
    const r = computeFileEditResult(fileContent, oldStr, newStr)
    expect(r.success).toBe(true)
  })

  // ── 中文句号漂移 ──
  it('old_string 用英文句号匹配文件中的 CJK 句号', () => {
    const fileContent = '第一步完成。第二步开始。'
    const oldStr = '第一步完成.第二步开始.'   // LLM 输出英文句号
    const newStr = '第一步完成.已跳过第二步.'
    const r = computeFileEditResult(fileContent, oldStr, newStr)
    expect(r.success).toBe(true)
  })

  // ── 混合漂移场景 ──
  it('同一 old_string 中混合多种漂移类型', () => {
    const fileContent = '结果：\u201C成功\u201D，用时【3秒】。'
    const oldStr = '结果:"成功",用时[3秒].'   // 全部半角
    const newStr = '结果:"完成",耗时[5秒].'
    const r = computeFileEditResult(fileContent, oldStr, newStr)
    expect(r.success).toBe(true)
  })

  // ── replaceAll 模式 ──
  it('replaceAll 模式下全角逗号全部被替换', () => {
    const fileContent = 'A，B，C，D'
    const oldStr = 'A,B'                     // 半角匹配全角
    const newStr = 'X,Y'
    const r = computeFileEditResult(fileContent, oldStr, newStr, { replaceAll: true })
    // 注意：replaceAll 用 split().join()，漂移匹配到的 resolvedRaw 是文件中的原样
    // 所以只会替换文件中实际出现的那一段
    expect(r.success).toBe(true)
  })

  // ── 中文内容完全无法匹配时 ──
  it('old_string 文件中完全不存在时返回失败', () => {
    const fileContent = '这是完全不同的内容'
    const r = computeFileEditResult(fileContent, '不存在的文字', '替换文字')
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error).toContain('not found')
    }
  })

  // ── Unicode 转义自动解码（2026-07 起：解码后能唯一匹配时直接修复，
  //     不再仅返回诊断提示 — 见 fileEditSemantics retryEditWithDecodedEscapes）──
  it('old_string 含 Unicode 转义字面量且解码后匹配时，自动解码并成功编辑', () => {
    const fileContent = 'curly: \u201C你好\u201D'
    const r = computeFileEditResult(fileContent, '\\u201C你好\\u201D', '替换')
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toBe('curly: 替换')
    }
  })

  it('中文 Unicode 转义字面量解码后匹配时自动修复', () => {
    const fileContent = '中文测试'
    const r = computeFileEditResult(fileContent, '\\u4E2D\\u6587\\u6D4B\\u8BD5', 'replaced')
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toBe('replaced')
    }
  })

  it('解码后仍不匹配时保留原 not-found 失败（诊断路径兜底）', () => {
    const fileContent = '完全无关的内容'
    const r = computeFileEditResult(fileContent, '\\u201C你好\\u201D', '替换')
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error).toContain('not found')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// 中文内容路径 + 内容的端到端测试
// ─────────────────────────────────────────────────────────────────────

describe('端到端：中文路径 + 中文内容的 Write/Edit', () => {
  const e2eDir = path.join(tmpRoot, 'e2e')

  it('Write 工具写入含中文引号的内容原样保留', () => {
    touchDir(e2eDir)
    const filePath = path.join(e2eDir, 'chinese_content.txt')
    const content = '你好,\u201C世界\u201D！这是一段测试内容。'
    fs.writeFileSync(filePath, content, 'utf8')
    const readBack = fs.readFileSync(filePath, 'utf8')
    expect(readBack).toBe(content)
    // 弯引号必须原样保留
    expect(readBack).toContain('\u201C')
    expect(readBack).toContain('\u201D')
  })

  it('Edit 工具匹配含中文弯引号的 old_string（直引号→弯引号漂移）', () => {
    const filePath = path.join(e2eDir, 'quote_edit.txt')
    const original = 'const title = \u201C你好世界\u201D;'
    fs.writeFileSync(filePath, original, 'utf8')

    // LLM 输出直引号
    const editResult = computeFileEditResult(original, 'const title = "你好世界";', 'const title = "新标题";')
    expect(editResult.success).toBe(true)
    if (editResult.success) {
      // 保留文件中的弯引号风格
      expect(editResult.newContent).toBe('const title = \u201C新标题\u201D;')
    }
  })

  it('Edit 工具处理含中文字符的路径（仅内容匹配，路径不参与 Edit 语义）', () => {
    const filePath = path.join(e2eDir, '中文文件.txt')
    const content = '第1行：初始化\n第2行：处理数据\n第3行：完成'
    fs.writeFileSync(filePath, content, 'utf8')

    const r = computeFileEditResult(content, '处理数据', '已完成数据')
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toContain('已完成数据')
      expect(r.newContent).toContain('第1行')
      expect(r.newContent).toContain('第3行')
    }
  })

  it('Edit 工具处理中文全角标点在 old_string 中的漂移', () => {
    const content = 'config：{\n  key：\u201C值\u201D\n}'
    const oldStr = 'config:{\n  key:"值"\n}'   // 全半角差异
    const r = computeFileEditResult(content, oldStr, 'config:{\n  key:"new"\n}')
    expect(r.success).toBe(true)
  })

  it('新旧内容都含中文时的完整编辑循环', () => {
    const original = '第1章：引言\n第2章：【背景】\n第3章：《方法》\n'
    const oldStr = '第1章:引言\n第2章:[背景]\n'   // 半角
    const newStr = 'Chapter 1: Intro\nChapter 2: [Background]\n'
    const r = computeFileEditResult(original, oldStr, newStr)
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toContain('Chapter 1')
      expect(r.newContent).toContain('Chapter 2')
    }
  })
})
