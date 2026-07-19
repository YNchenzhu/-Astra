/**
 * Local-timezone date helpers for system-prompt injection.
 *
 * `new Date().toISOString().split('T')[0]` returns the **UTC** date — wrong by
 * one day for users near midnight in non-UTC zones (e.g. UTC+8 between 00:00
 * and 08:00 sees "yesterday"; UTC-5 between 19:00 and 23:59 sees "tomorrow").
 *
 * `Intl.DateTimeFormat('en-CA', …)` produces YYYY-MM-DD in the runtime's local
 * timezone — same shape, correct day. Used by every site that injects the
 * "Today's date is …" / "Date:" line into the prompt.
 */
export function getTodayLocalISODate(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}
