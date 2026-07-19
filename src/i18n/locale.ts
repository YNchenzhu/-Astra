/**
 * UI 语言（界面显示语言）的类型与选项。
 *
 * 独立成无依赖文件，供 settings store 类型与 i18n 运行时共同引用，
 * 避免 `useSettingsStore` ↔ `i18n/index` 循环依赖。
 *
 * 注意：这与 settings 里的 `language`（AI 回复语言，自然语言名）是两个概念。
 * `uiLocale` 用 BCP-47 语言代码驱动整个界面的翻译。
 */

export type UiLocale = 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ko'

export const DEFAULT_UI_LOCALE: UiLocale = 'zh-CN'

/** 界面语言下拉选项：value 为 locale code，label 使用各语言自身的写法（endonym）。 */
export const UI_LOCALE_OPTIONS: { value: UiLocale; label: string }[] = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
]

export function isUiLocale(value: unknown): value is UiLocale {
  return (
    value === 'zh-CN' ||
    value === 'zh-TW' ||
    value === 'en' ||
    value === 'ja' ||
    value === 'ko'
  )
}
