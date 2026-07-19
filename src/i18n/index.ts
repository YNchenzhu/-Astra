/**
 * UI 国际化（i18n）运行时入口。
 *
 * - `useT()` —— React 组件订阅当前 `uiLocale` 并拿到对应语言的文案树。
 *   语言切换后，所有调用 `useT()` 的组件会自动重渲染。
 * - `getMessages(locale)` —— 非组件场景（工具函数、事件处理器）按需取文案。
 *
 * 文案树是强类型的：以简体中文（`zh-CN`）为 schema 基准，其余语言通过
 * `satisfies Messages` 对齐，缺键会在编译期报错。
 */
import { useSettingsStore } from '../stores/useSettingsStore'
import { DEFAULT_UI_LOCALE, type UiLocale } from './locale'
import { zhCN, type Messages } from './locales/zh-CN'
import { zhTW } from './locales/zh-TW'
import { en } from './locales/en'
import { ja } from './locales/ja'
import { ko } from './locales/ko'

const DICTIONARIES: Record<UiLocale, Messages> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  en,
  ja,
  ko,
}

export function getMessages(locale: UiLocale): Messages {
  return DICTIONARIES[locale] ?? DICTIONARIES[DEFAULT_UI_LOCALE]
}

/**
 * 组件内使用：返回当前界面语言对应的文案树。
 * 通过精细订阅 `uiLocale` 单字段，只有语言切换才触发重渲染。
 */
export function useT(): Messages {
  const locale = useSettingsStore((s) => s.uiLocale)
  return getMessages(locale)
}

export type { Messages }
export { DEFAULT_UI_LOCALE, UI_LOCALE_OPTIONS, isUiLocale } from './locale'
export type { UiLocale } from './locale'
