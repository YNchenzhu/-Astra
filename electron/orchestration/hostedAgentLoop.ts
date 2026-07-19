import type {
  AgenticLoopCallbacks,
  AgenticLoopOptions,
  AgenticLoopParams,
} from './phases/iteration'
import { runAgenticLoop } from './phases/iteration'
import { runAgenticLoopAsync } from '../ai/agenticLoopAsync'
import type { AgenticLoopResult, LoopEvent } from '../ai/loopEvents'
import {
  fingerprintTranscript,
  type TranscriptSnapshot,
} from './kernelTypes'
import {
  getToolAdmissionCoordinator,
  runWithToolAdmissionPort,
  type ToolAdmissionPort,
} from './toolRuntime/admission'

export interface AgentLoopHost {
  transcript: {
    rendererSeed: AgenticLoopParams['messages']
    getSnapshot(): TranscriptSnapshot
    commit(messages: Array<Record<string, unknown>>): TranscriptSnapshot
  }
  toolAdmission: ToolAdmissionPort
  control: {
    signal: AbortSignal
    iterationBoundary?: (iteration: number) => Promise<void>
  }
  lifecycle?: {
    onStart?: () => void
    onTerminate?: (result: AgenticLoopResult) => void
    onError?: (error: unknown) => void
  }
}

export function createInMemoryAgentLoopHost(
  params: Pick<AgenticLoopParams, 'messages' | 'initialApiMessages' | 'signal'>,
  options?: {
    toolAdmission?: ToolAdmissionPort
    lifecycle?: AgentLoopHost['lifecycle']
    initialSnapshot?: TranscriptSnapshot
    onTranscriptCommit?: (snapshot: TranscriptSnapshot) => void
    iterationBoundary?: (iteration: number) => Promise<void>
  },
): AgentLoopHost {
  const initialMessages = structuredClone(params.initialApiMessages ?? [])
  if (
    options?.initialSnapshot &&
    fingerprintTranscript(options.initialSnapshot.messages) !== options.initialSnapshot.fingerprint
  ) {
    throw new Error(
      `initial transcript fingerprint mismatch at revision ${options.initialSnapshot.revision}`,
    )
  }
  let snapshot: TranscriptSnapshot = options?.initialSnapshot
    ? structuredClone(options.initialSnapshot)
    : {
        revision: 0,
        fingerprint: fingerprintTranscript(initialMessages),
        messages: initialMessages,
      }
  return {
    transcript: {
      rendererSeed: structuredClone(params.messages),
      getSnapshot: () => structuredClone(snapshot),
      commit: (messages) => {
        const committedMessages = structuredClone(messages)
        snapshot = {
          revision: snapshot.revision + 1,
          fingerprint: fingerprintTranscript(committedMessages),
          messages: committedMessages,
        }
        options?.onTranscriptCommit?.(structuredClone(snapshot))
        return structuredClone(snapshot)
      },
    },
    toolAdmission: options?.toolAdmission ?? getToolAdmissionCoordinator(),
    control: {
      signal: params.signal,
      ...(options?.iterationBoundary
        ? { iterationBoundary: options.iterationBoundary }
        : {}),
    },
    ...(options?.lifecycle ? { lifecycle: options.lifecycle } : {}),
  }
}

function bindHostParams(
  host: AgentLoopHost,
  params: AgenticLoopParams,
): AgenticLoopParams {
  const priorTranscript = params.hostTranscript
  const priorBoundary = params.iterationBoundaryHook
  const hostSnapshot = host.transcript.getSnapshot()
  return {
    ...params,
    messages: structuredClone(host.transcript.rendererSeed),
    initialApiMessages: structuredClone(hostSnapshot.messages),
    signal: host.control.signal,
    iterationBoundaryHook: async (iteration) => {
      await host.control.iterationBoundary?.(iteration)
      return priorBoundary?.(iteration)
    },
    hostTranscript: {
      commit: (messages) => {
        host.transcript.commit(messages)
        priorTranscript?.commit(messages)
      },
      ...(priorTranscript?.drainInbox
        ? { drainInbox: () => priorTranscript.drainInbox?.() ?? { injected: false } }
        : {}),
    },
  }
}

export async function runHostedAgentLoop(
  host: AgentLoopHost,
  params: AgenticLoopParams,
  callbacks: AgenticLoopCallbacks,
  options?: AgenticLoopOptions,
): Promise<void> {
  host.lifecycle?.onStart?.()
  const bound = bindHostParams(host, params)
  try {
    await runWithToolAdmissionPort(host.toolAdmission, () =>
      runAgenticLoop(bound, callbacks, {
        onTerminate: (result) => {
          options?.onTerminate?.(result)
          host.lifecycle?.onTerminate?.(result)
        },
      }),
    )
  } catch (error) {
    host.lifecycle?.onError?.(error)
    throw error
  }
}

export async function* runHostedAgentLoopAsync(
  host: AgentLoopHost,
  params: AgenticLoopParams,
  fanOutTo?: AgenticLoopCallbacks,
): AsyncGenerator<LoopEvent, AgenticLoopResult, undefined> {
  host.lifecycle?.onStart?.()
  const generator = runAgenticLoopAsync(bindHostParams(host, params), fanOutTo)
  try {
    while (true) {
      const next = await runWithToolAdmissionPort(host.toolAdmission, () => generator.next())
      if (next.done) {
        host.lifecycle?.onTerminate?.(next.value)
        return next.value
      }
      yield next.value
    }
  } catch (error) {
    host.lifecycle?.onError?.(error)
    throw error
  } finally {
    await generator.return(undefined as never).catch(() => undefined)
  }
}
