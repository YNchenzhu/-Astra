/**
 * 通用常量与工具函数
 *
 * 日期、环境相关的辅助函数。
 * 简化版，适配 Electron 环境。
 */

/**
 * 获取本地 ISO 格式日期 (YYYY-MM-DD)。
 * 支持环境变量覆盖以便测试。
 */
export function getLocalISODate(): string {
  const override = process.env.CLAUDE_CODE_OVERRIDE_DATE;
  if (override) return override;
  return new Date().toISOString().split("T")[0];
}

/**
 * 获取本地月份年份 (如 "April 2026")。
 * 用于工具提示以减少缓存失效。
 */
export function getLocalMonthYear(): string {
  const date = new Date();
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `${months[date.getMonth()]} ${date.getFullYear()}`;
}
