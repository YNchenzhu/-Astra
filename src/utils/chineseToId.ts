/**
 * chineseToId —— 把任意中英混合文本转成合法的内部标识符。
 *
 * ID 约束:`[a-z0-9_-]`,首尾无破折号。
 *
 * 策略:
 *   1. 先用 `pinyin-pro` 把 CJK 字符转成带连字符的拼音(tone 去掉),
 *      然后再跟 ASCII 字符拼起来(pinyin-pro 自己会把非 CJK 原样保留)。
 *   2. 对整段结果做规范化:toLowerCase → 非白名单字符替换为 `-` → 压缩连续破折号 → 剥离首尾。
 *
 * 对于纯 ASCII 输入,`pinyin-pro` 不会触碰,效果等同于直接规范化。
 * 对于纯 CJK 输入,"售前工程师" → "shou-qian-gong-cheng-shi"。
 * 对于混合输入,"售前 Engineer 1" → "shou-qian-engineer-1"。
 *
 * 返回空串时意味着输入完全没有可用字符,调用方需显示"请输入有效字符"。
 */

import { pinyin } from 'pinyin-pro'

/**
 * 基础规范化:把任意字符串塞进 `[a-z0-9_-]` + 首尾破折号剥离。
 * 不碰 CJK,所以应该**先**走过拼音转换再调它。
 */
export function normalizeToIdChars(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * 把任意文本转成合法 ID。中文走拼音,英文保留,其它字符替换为破折号。
 *
 * 使用场景:
 *   - CreateBundleDialog 的 "显示名称" → "ID" 自动联动
 *   - InlineAddRow 的 "名称" → "ID" 自动联动
 *   - 用户也可以直接在 ID 框里打中文,blur 时会触发一次规范化
 */
export function chineseToId(raw: string): string {
  const text = raw.trim()
  if (text.length === 0) return ''

  // pinyin-pro 对非 CJK 字符默认**原样保留**,CJK 部分按 type:'string'+separator
  // 拼接成带分隔符的拼音。toneType: 'none' 去调号。
  // nonZh: 'consecutive' 让英文 / 数字区段之间不会插入多余空格。
  let romanized: string
  try {
    romanized = pinyin(text, {
      toneType: 'none',
      type: 'string',
      separator: '-',
      nonZh: 'consecutive',
    })
  } catch {
    // pinyin-pro 在极个别古僻字上可能抛,兜底让 normalize 直接处理原文
    romanized = text
  }

  return normalizeToIdChars(romanized)
}

/**
 * 对比 "是否自动联动" 的判定:当前 ID 等于根据 name 生成的 pinyin ID 就算
 * "还在自动联动"。用户一旦改 ID 字段,这个判断会返回 false,停止联动。
 */
export function isIdStillDerivedFrom(id: string, name: string): boolean {
  if (id.length === 0) return true
  return chineseToId(name) === id
}
