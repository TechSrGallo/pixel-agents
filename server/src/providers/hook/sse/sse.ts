import type { HookProvider } from '../../../../../core/src/provider.js';
import { BASH_COMMAND_DISPLAY_MAX_LENGTH } from '../../../constants.js';
import { SSE_MESSAGE_DISPLAY_MAX_LENGTH, SSE_PROVIDER_ID, SSE_READING_TOOLS } from './constants.js';
import { normalizeSseEvent } from './normalizeSseEvent.js';

// ── formatToolStatus: activity labels for SSE-driven agents ──
//
// toolName is either a synthetic status tool (working/thinking/reading/editing/
// running_tool/message, produced by normalizeSseEvent) or a real upstream tool
// name from `agent.tool.started` (shell, read, ...). input carries the upstream
// message/activity/command fields for the label.

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '\u2026' : text;
}

export function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  const message =
    typeof inp.message === 'string' && inp.message
      ? truncate(inp.message, SSE_MESSAGE_DISPLAY_MAX_LENGTH)
      : '';
  const activity =
    typeof inp.activity === 'string' && inp.activity
      ? truncate(inp.activity, SSE_MESSAGE_DISPLAY_MAX_LENGTH)
      : '';

  switch (toolName) {
    case 'working':
      return message || activity || 'Working';
    case 'thinking':
      return message || activity || 'Thinking';
    case 'reading':
      return message || activity || 'Reading';
    case 'editing':
      return message || activity || 'Editing';
    case 'running_tool':
      return message || activity || 'Running a tool';
    case 'message':
      return message || 'Sending a message';
    default: {
      const cmd = typeof inp.command === 'string' && inp.command ? inp.command : '';
      if (cmd) {
        return `Running: ${truncate(cmd, BASH_COMMAND_DISPLAY_MAX_LENGTH)}`;
      }
      return message || `Using ${toolName}`;
    }
  }
}

// ── Installer no-ops: SSE is push-based, there is nothing to install ──

function installHooks(_serverUrl: string, _authToken: string): Promise<void> {
  return Promise.resolve();
}

function uninstallHooks(): Promise<void> {
  return Promise.resolve();
}

function areHooksInstalled(): Promise<boolean> {
  // Always "installed": events arrive as long as the bridge is connected.
  return Promise.resolve(true);
}

// ── The provider ──
//
// Stream provider for external agent systems that push lifecycle/activity events
// over Server-Sent Events. No transcript files, no filesystem scanning, no team
// extension: every character is a hooks-only external agent fed by the bridge
// (sseBridge.ts) or by POSTs to /api/hooks/sse.

export const sseProvider: HookProvider = {
  kind: 'hook',
  id: SSE_PROVIDER_ID,
  displayName: 'External Agents (SSE)',
  protocolVersion: 1,

  normalizeHookEvent: normalizeSseEvent,

  installHooks,
  uninstallHooks,
  areHooksInstalled,

  formatToolStatus,
  permissionExemptTools: new Set<string>(),
  subagentToolNames: new Set<string>(),
  readingTools: SSE_READING_TOOLS,

  // Sessions come from an explicitly configured upstream; adopt every one of them
  // regardless of workspace project dirs or the "Watch All Sessions" setting.
  adoptAllSessions: true,
};
