/**
 * 阶段三：统一生命周期事件总线（替代仅靠 Prompt 触发侧车逻辑）
 *
 * TaskManager 仍为底层事实来源；此处提供 TaskCompleted / TaskFailed 的类型化订阅。
 */

import { EventEmitter } from 'node:events'
import type { Task } from '../tools/TaskManager'

export const LIFECYCLE_EVENTS = [
  'TaskCompleted',
  'TaskFailed',
] as const

export type LifecycleEventName = (typeof LIFECYCLE_EVENTS)[number]

export interface TaskCompletedPayload {
  /** 事件快照（outputChunks 可能为空） */
  snapshot: Task
  /** 完整任务（含 outputChunks），用于记忆提取等 */
  fullTask: Task
}

export interface TaskFailedPayload {
  snapshot: Task
  fullTask: Task
  error?: string
}

type LifecyclePayloadMap = {
  TaskCompleted: TaskCompletedPayload
  TaskFailed: TaskFailedPayload
}

type LifecycleListener<K extends LifecycleEventName> = (payload: LifecyclePayloadMap[K]) => void

class LifecycleEventBus extends EventEmitter {
  override on<K extends LifecycleEventName>(event: K, listener: LifecycleListener<K>): this {
    return super.on(event, listener as (...args: unknown[]) => void)
  }

  override once<K extends LifecycleEventName>(event: K, listener: LifecycleListener<K>): this {
    return super.once(event, listener as (...args: unknown[]) => void)
  }

  emitTaskCompleted(payload: TaskCompletedPayload): boolean {
    return this.emit('TaskCompleted', payload)
  }

  emitTaskFailed(payload: TaskFailedPayload): boolean {
    return this.emit('TaskFailed', payload)
  }
}

export const lifecycleEventBus = new LifecycleEventBus()
