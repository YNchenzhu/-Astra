import { buildTool } from './buildTool'
import { remoteTriggerInputZod } from './toolInputZod'
import {
  getRemoteTriggerStatus,
  startRemoteTriggerServer,
  stopRemoteTriggerServer,
} from './remoteTriggerServer'

export const remoteTriggerTool = buildTool({
  name: 'RemoteTrigger',
  zInputSchema: remoteTriggerInputZod,
  description:
    'Start or stop a local HTTP listener on 127.0.0.1 for POST /hook with header X-Trigger-Secret. ' +
    'Use for local automation wiring (CI, scripts). Body is accepted but not forwarded into the chat by default.',
  inputSchema: [
    {
      name: 'operation',
      type: 'string',
      description: 'start | stop | status',
      required: true,
      enum: ['start', 'stop', 'status'],
    },
  ],
  isReadOnly: false,
  isConcurrencySafe: false,
  maxResultChars: 8_000,
  async call({ operation }) {
    const op = String(operation ?? '').toLowerCase()
    if (op === 'status') {
      const s = getRemoteTriggerStatus()
      return {
        success: true,
        output: s.running
          ? `Remote trigger listening on http://127.0.0.1:${s.port}/hook (X-Trigger-Secret: ${s.secret})`
          : 'Remote trigger server is stopped.',
      }
    }
    if (op === 'stop') {
      await stopRemoteTriggerServer()
      return { success: true, output: 'Remote trigger server stopped.' }
    }
    if (op === 'start') {
      if (process.env.ASTRA_REMOTE_TRIGGER_DISABLED === '1') {
        return { success: false, error: 'Remote trigger disabled by ASTRA_REMOTE_TRIGGER_DISABLED=1.' }
      }
      const { port, secret } = await startRemoteTriggerServer()
      return {
        success: true,
        output:
          `POST http://127.0.0.1:${port}/hook\nHeader: X-Trigger-Secret: ${secret}\n`,
      }
    }
    return { success: false, error: 'operation must be start, stop, or status.' }
  },
})
