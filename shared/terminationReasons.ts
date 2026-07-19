export const KNOWN_TERMINATION_REASONS = [
  'blocking_limit',
  'aborted_streaming',
  'aborted_tools',
  'prompt_too_long',
  'image_error',
  'model_error',
  'stop_hook_prevented',
  'hook_stopped',
  'stop_hook_circuit_breaker',
  'iteration_boundary_stopped',
  'max_turns',
  'iteration_stalled',
  'output_budget_exhausted',
  'verification_required',
  'completed',
] as const

export type TerminationReason = (typeof KNOWN_TERMINATION_REASONS)[number]
