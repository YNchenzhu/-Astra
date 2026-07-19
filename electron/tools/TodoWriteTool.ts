/**
 * TodoWrite Tool — manage a session-level task list.
 *
 * Mirrors upstream's TodoWriteTool: creates, updates, and tracks
 * structured task lists for coding sessions. Supports per-agent task
 * lists, verification nudge, and rich prompt guidance.
 */

import type { ToolResult } from './types'
import { buildTool } from './buildTool'
import { isTodoV1Enabled } from './todoMode'
import { todoWriteInputZod } from './toolInputZod'
import { describeVerificationAction } from '../ai/agenticLoop/verificationGate'
import { getAgentContext } from '../agents/agentContext'
import { extractCurrentUserQueryText } from '../context/anchorUserQuery'
import {
  looksLikeDirectionChange,
  scriptsAreIncomparable,
} from '../context/informativeTokens'

// ============================================================
// Types
// ============================================================

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string
}

// ============================================================
// In-memory store keyed by agent ID or session ID
// ============================================================

const todoStore = new Map<string, TodoItem[]>()

// P2 (intent comprehension): the user's ultimate objective for the active
// task — the *why* behind the work, captured verbatim from TodoWrite's
// optional `objective` field. Kept in a sibling map (rather than widening
// `TodoItem[]`) so every existing `getTodos` consumer is untouched. Goal
// recitation re-surfaces this at the tail of the model's context so deep
// intent survives long runs, not just the step list.
//
// 2026-07 复审 P0 fix — objectives are MODEL-authored, yet goal recitation
// used to re-surface them every request labelled "the user's ultimate
// goal" with zero host validation: a first-turn misread got amplified for
// the rest of the task. Each entry now carries a `verified` flag computed
// at WRITE time by comparing the objective against the current user query
// (same zero-overlap tokenizer the objectiveConflict collector uses at
// turn entry). Unverified objectives are still stored and recited, but
// with candidate framing so the model treats the ORIGINAL instruction as
// authoritative on conflict.
export interface TodoObjectiveMeta {
  text: string
  /**
   * `true` when the objective shares informative tokens with the user's
   * current request (or when no comparison was possible — no ambient
   * conversation, either text too short). `false` ONLY on a meaningful
   * zero-overlap verdict, i.e. the objective talks about something the
   * current request never mentioned.
   */
  verified: boolean
}

const objectiveStore = new Map<string, TodoObjectiveMeta>()

export function getTodos(key?: string): TodoItem[] {
  const k = key ?? '__default__'
  return todoStore.get(k) ?? []
}

/** The captured task objective for `key`, or `''` when none is set. */
export function getTodoObjective(key?: string): string {
  const k = key ?? '__default__'
  return objectiveStore.get(k)?.text ?? ''
}

/** Objective text + write-time verification flag, or `undefined` when none is set. */
export function getTodoObjectiveMeta(key?: string): TodoObjectiveMeta | undefined {
  const k = key ?? '__default__'
  return objectiveStore.get(k)
}

/**
 * Write-time validation (2026-07 复审 P0 fix): compare the model-authored
 * objective against the CURRENT user query extracted from the ambient
 * AgentContext conversation. Returns `false` only on a meaningful
 * zero-overlap verdict; missing context / short texts give the benefit of
 * the doubt (`true`), preserving pre-fix behaviour for restore paths and
 * sub-agent scopes where no comparable query exists.
 */
function verifyObjectiveAgainstCurrentQuery(objective: string): boolean {
  try {
    const messages = getAgentContext()?.messages
    if (!Array.isArray(messages) || messages.length === 0) return true
    const query = extractCurrentUserQueryText(
      messages as Array<Record<string, unknown>>,
    )?.trim()
    if (!query) return true
    // F2 (2026-07 会话审计) — cross-script abstention: an English
    // objective against a Chinese query yields zero token overlap by
    // construction (ASCII words vs CJK bigrams), not because the model
    // misread the goal. When the two texts share no comparable script,
    // give the benefit of the doubt instead of falsely downgrading the
    // objective to candidate framing.
    if (scriptsAreIncomparable(objective, query)) return true
    return !looksLikeDirectionChange(objective, query)
  } catch {
    return true
  }
}

/**
 * Set (or clear, with an empty string) the captured task objective for
 * `key`. Exported so the durable V2 surface (`TaskCreate`) can record the
 * same "why" into the shared store — see audit P2-V2. A non-empty value
 * overwrites; an empty/whitespace value clears. The stored entry carries
 * the write-time `verified` verdict (see {@link TodoObjectiveMeta}).
 */
export function setTodoObjective(key: string | undefined, objective: string): void {
  const k = key ?? '__default__'
  const trimmed = objective.trim()
  if (trimmed) {
    objectiveStore.set(k, {
      text: trimmed,
      verified: verifyObjectiveAgainstCurrentQuery(trimmed),
    })
  } else {
    objectiveStore.delete(k)
  }
}

export function resetTodos(key?: string): void {
  const k = key ?? '__default__'
  todoStore.delete(k)
  objectiveStore.delete(k)
}

export function setTodos(key: string, todos: TodoItem[]): void {
  todoStore.set(key, todos)
}

/**
 * Returns `true` when the agent has any todo item still in `pending`
 * or `in_progress` state. upstream's stale-todo nudge inlines this
 * check inside the attachment collector; we extract it here so the
 * collector + any other consumer reads identical semantics (no
 * counted-completed false positives, no allocation per call).
 */
export function hasActiveTodos(key?: string): boolean {
  const k = key ?? '__default__'
  const list = todoStore.get(k)
  if (!list || list.length === 0) return false
  for (const t of list) {
    if (t.status === 'pending' || t.status === 'in_progress') return true
  }
  return false
}

// ============================================================
// Prompt — from upstream's TodoWriteTool/prompt.ts
// ============================================================

// Full upstream TodoWrite prompt — this is the `description` the tool
// actually ships to the model, so it drives when / how the agent reaches
// for TodoWrite. Editing the text below changes agent behaviour at the
// next turn (no build step needed; `todoWriteTool.description` below
// points straight at this constant).
const TODO_WRITE_PROMPT = `Use this tool to create and manage a structured task list for your current work session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool
Use this tool proactively in these scenarios:

1. Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
2. Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
3. User explicitly requests todo list - When the user directly asks you to use the todo list
4. User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
5. After receiving new instructions - Immediately capture user requirements as todos
6. When you start working on a task - Mark it as in_progress BEFORE beginning work. Ideally you should only have one todo as in_progress at a time
7. After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

IMPORTANT — one call, not two: when you FIRST create the list, set the first task to in_progress in that SAME call. Do NOT create an all-pending list and then immediately call TodoWrite again just to flip the first item's status. Never issue two consecutive TodoWrite calls with no actual work between them.

## Capturing the objective (the *why*)

When you first create the list, also set the optional \`objective\` field to ONE sentence describing the user's underlying goal — the outcome that makes the task a success in their eyes, not a paraphrase of the steps. This is re-surfaced to you near the end of your context on later turns, so the deep intent stays in focus even as the transcript fills with tool output. Set it once; only revise it if the goal genuinely changes. Good: "User wants the checkout flow to stop dropping orders on timeout." Bad (just restates a step): "Fix the bug in checkout.ts."

## When NOT to Use This Tool

Skip using this tool when:
1. There is only a single, straightforward task
2. The task is trivial and tracking it provides no organizational benefit
3. The task can be completed in less than 3 trivial steps
4. The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Examples of When to Use the Todo List

<example>
User: I want to add a dark mode toggle to the application settings. Make sure you run the tests and build when you're done!
Assistant: *Creates todo list with the following items:*
1. Creating dark mode toggle component in Settings page
2. Adding dark mode state management (context/store)
3. Implementing CSS-in-JS styles for dark theme
4. Updating existing components to support theme switching
5. Running tests and build process, addressing any failures or errors that occur
*Begins working on the first task*

<reasoning>
The assistant used the todo list because:
1. Adding dark mode is a multi-step feature requiring UI, state management, and styling changes
2. The user explicitly requested tests and build be run afterward
3. The assistant inferred that tests and build need to pass by adding "Ensure tests and build succeed" as the final task
</reasoning>
</example>

<example>
User: Help me rename the function getCwd to getCurrentWorkingDirectory across my project
Assistant: *Uses grep or search tools to locate all instances of getCwd in the codebase*
I've found 15 instances of 'getCwd' across 8 different files.
*Creates todo list with specific items for each file that needs updating*

<reasoning>
The assistant used the todo list because:
1. First, the assistant searched to understand the scope of the task
2. Upon finding multiple occurrences across different files, it determined this was a complex task with multiple steps
3. The todo list helps ensure every instance is tracked and updated systematically
4. This approach prevents missing any occurrences and maintains code consistency
</reasoning>
</example>

<example>
User: I need to implement these features for my e-commerce site: user registration, product catalog, shopping cart, and checkout flow.
Assistant: *Creates a todo list breaking down each feature into specific tasks based on the project architecture*
Let's start with user registration. This will involve creating database models, API endpoints, and frontend forms that integrate with your existing authentication system.

<reasoning>
The assistant used the todo list because:
1. The user provided multiple complex features to implement in a comma separated list
2. The todo list helps organize these large features into manageable tasks
3. This approach allows for tracking progress across the entire implementation
</reasoning>
</example>

<example>
User: Can you help optimize my React application? It's rendering slowly and has performance issues.
Assistant: *Reviews component structure, render patterns, state management, and data fetching*
After analyzing your codebase, I've identified several performance issues.
*Creates todo list with items like: 1) Implementing memoization for expensive calculations in ProductList, 2) Adding virtualization for long lists in Dashboard, 3) Optimizing image loading in Gallery component, 4) Fixing state update loops in ShoppingCart, 5) Reviewing bundle size and implementing code splitting*
Let's start by implementing memoization for the expensive calculations in your ProductList component.

<reasoning>
The assistant used the todo list because:
1. First, the assistant examined the codebase to identify specific performance issues
2. Based on this analysis, it identified multiple optimization opportunities
3. Performance optimization is a non-trivial task requiring multiple steps
4. The todo list helps methodically track improvements across different components
5. This systematic approach ensures all performance bottlenecks are addressed
</reasoning>
</example>

## Examples of When NOT to Use the Todo List

<example>
User: How do I print 'Hello World' in Python?
Assistant: In Python, you can print "Hello World" with this simple code:

python
print("Hello World")

This will output the text "Hello World" to the console when executed.

<reasoning>
The assistant did not use the todo list because this is a single, trivial task that can be completed in one step. There's no need to track multiple tasks or steps for such a straightforward request.
</reasoning>
</example>

<example>
User: What does the git status command do?
Assistant: The git status command shows the current state of your working directory and staging area. It displays which changes have been staged, which haven't, and which files aren't being tracked by Git. This is a fundamental command for understanding the current state of your repository before making commits.

<reasoning>
The assistant did not use the todo list because this is an informational request with no actual coding task to complete. The user is simply asking for an explanation, not for the assistant to perform multiple steps or tasks.
</reasoning>
</example>

<example>
User: Can you add a comment to the calculateTotal function to explain what it does?
Assistant: Sure, let me add a comment to the calculateTotal function to explain what it does.
* Uses the edit_file tool to add a comment to the calculateTotal function *

<reasoning>
The assistant did not use the todo list because this is a single, straightforward task confined to one location in the code. Adding a comment doesn't require tracking multiple steps or systematic organization.
</reasoning>
</example>

<example>
User: Run npm install for me and tell me what happens.
Assistant: I'll run the npm install command for you.

*Executes: npm install*

The command completed successfully. Here's the output:
[Output of npm install command]

All dependencies have been installed according to your package.json file.

<reasoning>
The assistant did not use the todo list because this is a single command execution with immediate results. There are no multiple steps to track or organize, making the todo list unnecessary for this straightforward task.
</reasoning>
</example>

## Task States and Management

1. **Task States**: Use these states to track progress:
   - pending: Task not yet started
   - in_progress: Currently working on (limit to ONE task at a time)
   - completed: Task finished successfully

   **IMPORTANT**: Task descriptions must have two forms:
   - content: The imperative form describing what needs to be done (e.g., "Run tests", "Build the project")
   - activeForm: The present continuous form shown during execution (e.g., "Running tests", "Building the project")

2. **Task Management**:
   - Update task status in real-time as you work
   - Mark tasks complete IMMEDIATELY after finishing (don't batch completions)
   - Exactly ONE task must be in_progress at any time (not less, not more)
   - Complete current tasks before starting new ones
   - Remove tasks that are no longer relevant from the list entirely

3. **Task Completion Requirements**:
   - ONLY mark a task as completed when you have FULLY accomplished it
   - If you encounter errors, blockers, or cannot finish, keep the task as in_progress
   - When blocked, create a new task describing what needs to be resolved
   - Never mark a task as completed if:
     - Tests are failing
     - Implementation is partial
     - You encountered unresolved errors
     - You couldn't find necessary files or dependencies

4. **Task Breakdown**:
   - Create specific, actionable items
   - Break complex tasks into smaller, manageable steps
   - Use clear, descriptive task names
   - Always provide both forms:
     - content: "Fix authentication bug"
     - activeForm: "Fixing authentication bug"

## When to Use TaskCreate Instead

TodoWrite is **intentionally ephemeral**: the list lives in memory for this conversation only and auto-clears when every item is \`completed\`. If your task needs ANY of the following, use **TaskCreate** (the durable managed-task surface) instead:

- The work must survive across conversations / restarts (persisted to disk)
- You need an \`owner\` to delegate to another agent / teammate
- There are explicit \`blockedBy\` dependencies between tasks
- The user explicitly framed it as a "project task" or asked to "track this"
- Completion should trigger memory extraction for long-term recall

TodoWrite and TaskCreate are **complementary, not redundant** — pick TodoWrite for the lightweight live checklist that shows the user what you're about to do this turn; pick TaskCreate for the structured durable item. Do not mirror the same work item in both surfaces.

When in doubt, use this tool. Being proactive with task management demonstrates attentiveness and ensures you complete all requirements successfully.`

// ============================================================
// Tool definition
// ============================================================

export const todoWriteTool = buildTool({
  name: 'TodoWrite',
  zInputSchema: todoWriteInputZod,
  // 星构Astra coexist extension: V1 and V2 are no longer mutually
  // exclusive. In `'coexist'` mode BOTH surfaces are enabled and the
  // model picks per task (TodoWrite for ephemeral session checklists,
  // TaskCreate for durable cross-conversation work). The
  // `'v1-only'` / `'v2-only'` modes still narrow to one side; see
  // `todoMode.ts` for the resolution order.
  isEnabled: () => isTodoV1Enabled(),
  description: TODO_WRITE_PROMPT,
  searchHint: 'manage the session task checklist',
  inputSchema: [
    {
      name: 'todos',
      type: 'array',
      description:
        'The updated todo list. Each object: { content: string (imperative form), ' +
        'status: "pending"|"in_progress"|"completed", activeForm: string (present continuous form) }',
      required: true,
      items: {
        type: 'object',
        description: '{ content: string, status: "pending"|"in_progress"|"completed", activeForm: string }',
      },
    },
    {
      name: 'objective',
      type: 'string',
      description:
        "One sentence stating the user's UNDERLYING OBJECTIVE for this task — the *why* / the outcome that makes it a success in their eyes, NOT a restatement of the steps. " +
        'Set this once when you first create the list (and only update it if the goal genuinely shifts). It is re-surfaced to keep the deep intent in focus during long runs. Example: "User wants new contributors to get the dev server running in under 5 minutes" — not "Update the README".',
      required: false,
    },
  ],
  isReadOnly: false,
  isConcurrencySafe: false,
  // 2026-05 — previously `shouldDefer: true` + `deferUntil: () => true`,
  // which `shouldExposeDeferredTool` short-circuits as "always exposed"
  // (deferUntil winning over shouldDefer). The pair was a no-op gate and
  // confused readers into thinking TodoWrite needed ToolSearch
  // discovery — it never did. Switching to `alwaysLoad: true` keeps the
  // exact same behaviour but makes the intent obvious and lets the
  // deferred-tool guards skip TodoWrite entirely.
  alwaysLoad: true,
  // upstream alignment extra-1: was using a custom narrow context type
  // `{ agentId?: string }` which was incompatible with `buildTool`'s
  // generic ctx parameter. Standard `ToolUseContext` already carries
  // `agentId` (defaulted to 'main' for the main thread), and when ctx
  // is undefined (direct registry/test calls) the fallback path stays
  // `'__default__'` — behaviorally identical to the old signature.
  async call(input, ctx): Promise<ToolResult> {
    const rawTodos = input.todos
    if (!Array.isArray(rawTodos)) {
      return { success: false, error: 'todos must be an array' }
    }

    // BUG-H6 fix: cap the per-call todo list size so a runaway agent
    // (or a malicious skill / hook) cannot drive the in-memory store
    // toward unbounded growth. 200 is well past any realistic plan
    // depth; below it we behave exactly as before.
    const MAX_TODO_ITEMS_PER_CALL = 200
    if (rawTodos.length > MAX_TODO_ITEMS_PER_CALL) {
      return {
        success: false,
        error: `Too many todo items in a single call (${rawTodos.length} > max ${MAX_TODO_ITEMS_PER_CALL}). Split the plan or remove completed items first.`,
      }
    }

    const validStatuses = new Set(['pending', 'in_progress', 'completed'])
    const parsed: TodoItem[] = []

    for (const item of rawTodos) {
      if (!item || typeof item !== 'object') {
        return { success: false, error: `Invalid todo item: ${JSON.stringify(item)}` }
      }
      const content = typeof item.content === 'string' ? item.content.trim() : ''
      const status = typeof item.status === 'string' && validStatuses.has(item.status)
        ? item.status as TodoItem['status']
        : 'pending'
      const activeForm = typeof item.activeForm === 'string' ? item.activeForm.trim() : content

      if (!content) {
        return { success: false, error: 'Each todo must have a non-empty content string' }
      }
      parsed.push({ content, status, activeForm })
    }

    // Enforce the "exactly one in_progress" invariant the prompt promises
    // (audit F-13: it was previously prompt-only, so a model could submit
    // several in_progress items at once, defeating the single-current-step
    // model the plan-step driver and goal recitation rely on). Keep the FIRST
    // in_progress as the current step; demote the rest to `pending`.
    // Deterministic and order-preserving — never promotes, only demotes.
    let sawInProgress = false
    for (const t of parsed) {
      if (t.status !== 'in_progress') continue
      if (sawInProgress) t.status = 'pending'
      else sawInProgress = true
    }

    // Key by agent ID (sub-agent isolation) or default session
    const todoKey = ctx?.agentId ?? '__default__'
    const oldTodos = todoStore.get(todoKey) ?? []

    // When all items are completed, reset the list (upstream behavior)
    const allDone = parsed.length > 0 && parsed.every(t => t.status === 'completed')
    const newTodos = allDone ? [] : parsed

    todoStore.set(todoKey, newTodos)

    // P2: capture the task objective. A non-empty `objective` (re)sets the
    // stored purpose; omitting it on an update preserves the prior one, so
    // the model only needs to state the "why" once at task start. When the
    // list fully resets (all done), drop the objective too — the task is
    // over and a stale purpose must not leak into the next one.
    const objective = typeof input.objective === 'string' ? input.objective.trim() : ''
    if (allDone) {
      objectiveStore.delete(todoKey)
    } else if (objective) {
      // Route through the canonical setter so the write-time verification
      // verdict (2026-07 复审 P0 fix) is applied on this path too.
      setTodoObjective(todoKey, objective)
    }

    // Verification nudge: 3+ items completed with no verification step
    // (Mirrors upstream's VERIFICATION_AGENT feature gate). Work-package
    // aware: the phrasing comes from the active bundle's verification policy
    // (code → tests/build; writing → self-review; etc.) and is suppressed
    // entirely when the policy is `none`, so a non-coding work package is
    // never told to "run tests".
    let verificationNudgeNeeded = false
    if (
      allDone &&
      oldTodos.length >= 3 &&
      !oldTodos.some(t => /verif/i.test(t.content))
    ) {
      verificationNudgeNeeded = true
    }

    // Consecutive-call hygiene (2026-07 audit): the most common wasteful
    // pattern is "create the list, then immediately re-call TodoWrite just
    // to flip item 1 to in_progress" (or re-send an identical list). The
    // repetition guard can't see it (statuses differ → different exact
    // fingerprint; TodoWrite has no target field for the normalized layer),
    // so detect it here against the stored list and append an advisory.
    // Advisory only — the write still succeeds exactly as submitted.
    let consecutiveCallNote = ''
    if (oldTodos.length > 0 && newTodos.length === oldTodos.length) {
      const sameContents = newTodos.every((t, i) => t.content === oldTodos[i].content)
      if (sameContents) {
        const sameStatuses = newTodos.every((t, i) => t.status === oldTodos[i].status)
        const anyNewlyCompleted = newTodos.some(
          (t, i) => t.status === 'completed' && oldTodos[i].status !== 'completed',
        )
        if (sameStatuses) {
          consecutiveCallNote =
            '\n\nNOTE: This call did not change the list (identical to the current list). ' +
            'Avoid redundant TodoWrite calls — only call it when items or statuses actually change.'
        } else if (!anyNewlyCompleted) {
          consecutiveCallNote =
            '\n\nNOTE: This call only flipped item status(es) without completing anything. ' +
            'When creating a list, set the first task to in_progress in that same call ' +
            'instead of issuing a separate follow-up TodoWrite.'
        }
      }
    }

    const baseMsg = 'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable.'
    const verificationAction = verificationNudgeNeeded ? describeVerificationAction() : null
    const nudge = verificationAction
      ? `\n\nNOTE: You just closed out 3+ tasks and none of them was a verification step. Consider ${verificationAction} before writing your final summary.`
      : ''
    const message = baseMsg + nudge + consecutiveCallNote

    // Renderer `useChatStore` `tool_result` branch JSON.parse(output) and reads `items` to drive TodoPanel.
    // P2-OBS: echo the active objective in the output too, so the details
    // drawer / persisted transcript carry the user's underlying goal, not
    // just the step list.
    const activeObjective = objectiveStore.get(todoKey)?.text ?? ''
    return {
      success: true,
      output: JSON.stringify(
        activeObjective
          ? { items: newTodos, objective: activeObjective, message }
          : { items: newTodos, message },
      ),
    }
  },
})
