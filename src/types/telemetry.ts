// ============================================================================
// Telemetry / Analytics Types
// Based on protobuf-generated types from upstream events_mono schema
// ============================================================================

import type { SessionId, AgentId } from './ids'

/**
 * Protobuf timestamp representation.
 * Seconds and nanoseconds since Unix epoch (1970-01-01T00:00:00Z).
 */
export interface Timestamp {
  seconds?: number
  nanos?: number
}

/**
 * Authentication context automatically injected by the API.
 */
export interface PublicApiAuth {
  account_id?: number
  organization_uuid?: string
  account_uuid?: string
}

/**
 * GitHub Actions-specific environment information.
 */
export interface GitHubActionsMetadata {
  actor_id?: string
  repository_id?: string
  repository_owner_id?: string
}

/**
 * Comprehensive environment and runtime metadata.
 */
export interface EnvironmentMetadata {
  platform?: string
  node_version?: string
  terminal?: string
  package_managers?: string
  runtimes?: string
  is_running_with_bun?: boolean
  is_ci?: boolean
  is_claubbit?: boolean
  is_github_action?: boolean
  is_claude_code_action?: boolean
  is_claude_ai_auth?: boolean
  version?: string
  github_event_name?: string
  github_actions_runner_environment?: string
  github_actions_runner_os?: string
  github_action_ref?: string
  wsl_version?: string
  github_actions_metadata?: GitHubActionsMetadata
  arch?: string
  is_claude_code_remote?: boolean
  remote_environment_type?: string
  claude_code_container_id?: string
  claude_code_remote_session_id?: SessionId
  tags?: string[]
  deployment_environment?: string
  is_conductor?: boolean
  version_base?: string
  coworker_type?: string
  build_time?: string
  is_local_agent_mode?: boolean
  linux_distro_id?: string
  linux_distro_version?: string
  linux_kernel?: string
  vcs?: string
  platform_raw?: string
}

/**
 * Slack integration context for Claude-in-Slack events.
 */
export interface SlackContext {
  slack_team_id?: string
  is_enterprise_install?: boolean
  trigger?: string
  creation_method?: string
}

/**
 * Internal event logged from the application via analytics pipeline.
 * This schema covers all fields from the events_mono protobuf definition.
 */
export interface ClaudeCodeInternalEvent {
  event_name?: string
  client_timestamp?: Date
  model?: string
  session_id?: SessionId
  user_type?: string
  betas?: string
  env?: EnvironmentMetadata
  entrypoint?: string
  agent_sdk_version?: string
  is_interactive?: boolean
  client_type?: string
  process?: string
  additional_metadata?: string
  auth?: PublicApiAuth
  server_timestamp?: Date
  event_id?: string
  device_id?: string
  swe_bench_run_id?: string
  swe_bench_instance_id?: string
  swe_bench_task_id?: string
  email?: string
  agent_id?: AgentId
  parent_session_id?: SessionId
  agent_type?: string
  slack?: SlackContext
  team_name?: string
  skill_name?: string
  plugin_name?: string
  marketplace_name?: string
}

/**
 * GrowthBook experiment assignment event.
 * Tracks when a user is exposed to an experiment variant.
 */
export interface GrowthbookExperimentEvent {
  event_id?: string
  timestamp?: Date
  experiment_id?: string
  variation_id?: number
  environment?: string
  user_attributes?: string
  experiment_metadata?: string
  device_id?: string
  auth?: PublicApiAuth
  session_id?: SessionId
  anonymous_id?: string
  event_metadata_vars?: string
}

/**
 * Convert a Protobuf Timestamp to a JavaScript Date.
 */
export function fromTimestamp(ts: Timestamp): Date {
  const millis = (ts.seconds || 0) * 1_000 + (ts.nanos || 0) / 1_000_000
  return new Date(millis)
}

/**
 * Convert a JavaScript Date to a Protobuf Timestamp.
 */
export function toTimestamp(date: Date): Timestamp {
  const millis = date.getTime()
  return {
    seconds: Math.floor(millis / 1_000),
    nanos: (millis % 1_000) * 1_000_000,
  }
}

/**
 * Serialize a ClaudeCodeInternalEvent to JSON for transmission.
 */
export function serializeInternalEvent(
  event: ClaudeCodeInternalEvent,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (event.event_name) result.event_name = event.event_name
  if (event.client_timestamp) result.client_timestamp = event.client_timestamp.toISOString()
  if (event.model) result.model = event.model
  if (event.session_id) result.session_id = event.session_id
  if (event.user_type) result.user_type = event.user_type
  if (event.betas) result.betas = event.betas
  if (event.env) result.env = event.env
  if (event.entrypoint) result.entrypoint = event.entrypoint
  if (event.agent_sdk_version) result.agent_sdk_version = event.agent_sdk_version
  if (event.is_interactive !== undefined) result.is_interactive = event.is_interactive
  if (event.client_type) result.client_type = event.client_type
  if (event.process) result.process = event.process
  if (event.additional_metadata) result.additional_metadata = event.additional_metadata
  if (event.auth) result.auth = event.auth
  if (event.server_timestamp) result.server_timestamp = event.server_timestamp.toISOString()
  if (event.event_id) result.event_id = event.event_id
  if (event.device_id) result.device_id = event.device_id
  if (event.swe_bench_run_id) result.swe_bench_run_id = event.swe_bench_run_id
  if (event.swe_bench_instance_id) result.swe_bench_instance_id = event.swe_bench_instance_id
  if (event.swe_bench_task_id) result.swe_bench_task_id = event.swe_bench_task_id
  if (event.email) result.email = event.email
  if (event.agent_id) result.agent_id = event.agent_id
  if (event.parent_session_id) result.parent_session_id = event.parent_session_id
  if (event.agent_type) result.agent_type = event.agent_type
  if (event.slack) result.slack = event.slack
  if (event.team_name) result.team_name = event.team_name
  if (event.skill_name) result.skill_name = event.skill_name
  if (event.plugin_name) result.plugin_name = event.plugin_name
  if (event.marketplace_name) result.marketplace_name = event.marketplace_name
  return result
}
