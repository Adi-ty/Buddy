import type { EventMapping } from './types'

export const hookRules: Record<string, EventMapping> = {
  SessionStart: { status: 'idle', action: 'observe' },
  SessionEnd: { status: null, action: 'close' },
  UserPromptSubmit: { status: 'working', action: 'observe' },
  PreToolUse: { status: 'working', action: 'observe' },
  PostToolUse: { status: 'working', action: 'observe' },
  PostToolUseFailure: { status: 'error', action: 'observe', turnActive: true },
  PermissionRequest: { status: 'needs-attention', action: 'permission' },
  PermissionDenied: { status: null, action: 'resolve' },
  Stop: { status: 'completed', action: 'observe' },
  StopFailure: { status: 'error', action: 'observe', turnActive: false },
  Interrupt: { status: 'interrupted', action: 'observe' },
  SubagentStart: { status: 'working', action: 'observe' },
  SubagentStop: {
    status: 'completed',
    action: 'observe',
    preserveErrorOnCompletion: true,
    turnActive: false,
  },
  Notification: { status: null, action: 'observe' },
  PreCompact: { status: 'working', action: 'observe' },
  PostCompact: { status: null, action: 'observe' },
}
export const commonHookEvents = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
]
