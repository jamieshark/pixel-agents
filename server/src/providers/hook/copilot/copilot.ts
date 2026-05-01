import * as path from 'path';

import {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
} from '../../../constants.js';
import type { AgentEvent, HookProvider } from '../../../provider.js';

// ── formatToolStatus: lowercase Copilot tool names ──

export function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  const base = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
  switch (toolName) {
    case 'bash': {
      const cmd = (inp.command as string) || '';
      return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`;
    }
    case 'edit':
      return `Editing ${base(inp.file_path ?? inp.path)}`;
    case 'view':
    case 'get_file':
      return `Reading ${base(inp.file_path ?? inp.path)}`;
    case 'create':
      return `Writing ${base(inp.file_path ?? inp.path)}`;
    case 'glob':
    case 'list_files':
      return 'Searching files';
    case 'grep':
    case 'search_code':
      return 'Searching code';
    case 'web_fetch':
      return 'Fetching web content';
    case 'web_search':
      return 'Searching the web';
    default:
      return `Using ${toolName}`;
  }
}

// ── normalizeHookEvent: Copilot VS Code compat format (snake_case fields, PascalCase event names) ──
//
// Differences from Claude:
// - No TeammateIdle / TaskCompleted / TaskCreated events
// - SessionEnd reason 'complete' = normal exit (no 'clear'/'resume')
// - SubagentStart uses camelCase fields (no hook_event_name) -- dropped silently
// - No PermissionRequest event

function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = raw.hook_event_name;
  const sessionId = raw.session_id;
  if (typeof eventName !== 'string' || typeof sessionId !== 'string') return null;

  switch (eventName) {
    case 'PreToolUse': {
      const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : '';
      const toolInput =
        typeof raw.tool_input === 'object' && raw.tool_input !== null
          ? (raw.tool_input as Record<string, unknown>)
          : {};
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId: `hook-${Date.now()}`,
          toolName,
          input: toolInput,
        },
      };
    }

    case 'PostToolUse':
    case 'PostToolUseFailure':
      return { sessionId, event: { kind: 'toolEnd', toolId: 'current' } };

    case 'Stop':
      return { sessionId, event: { kind: 'turnEnd' } };

    case 'UserPromptSubmit':
      return { sessionId, event: { kind: 'userTurn' } };

    case 'SessionStart':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: typeof raw.source === 'string' ? raw.source : undefined,
        },
      };

    case 'SessionEnd':
      return {
        sessionId,
        event: {
          kind: 'sessionEnd',
          reason: typeof raw.reason === 'string' ? raw.reason : undefined,
        },
      };

    // SubagentStop is subscribed but not yet supported — drop silently.
    // SubagentStart uses camelCase (no hook_event_name) and is already filtered by
    // the initial typeof check above.
    case 'SubagentStop':
    default:
      return null;
  }
}

// ── The provider ──

export const copilotProvider: HookProvider = {
  kind: 'hook',
  id: 'copilot',
  displayName: 'GitHub Copilot CLI',

  normalizeHookEvent,

  // Copilot hooks are workspace-scoped — install/uninstall must be called directly
  // via copilotHookInstaller with a workspaceCwd argument. These methods throw to
  // prevent accidental use; callers must use copilotHookInstaller directly.
  installHooks: (_serverUrl: string, _authToken: string): Promise<void> => {
    return Promise.reject(new Error('copilotProvider.installHooks: use copilotHookInstaller.installHooks(workspaceCwd) directly'));
  },
  uninstallHooks: (): Promise<void> => {
    return Promise.reject(new Error('copilotProvider.uninstallHooks: use copilotHookInstaller.uninstallHooks(workspaceCwd) directly'));
  },
  areHooksInstalled: (): Promise<boolean> => {
    return Promise.reject(new Error('copilotProvider.areHooksInstalled: use copilotHookInstaller.areHooksInstalled(workspaceCwd) directly'));
  },

  formatToolStatus,
  // All tools except bash are read-only file ops that don't require permission prompts.
  permissionExemptTools: new Set(['view', 'grep', 'glob', 'web_fetch', 'web_search', 'get_file', 'list_files', 'search_code']),
  // No subagent characters for Copilot (first implementation)
  subagentToolNames: new Set(),

  // Copilot is hooks-only — no JSONL transcript files to parse
  getSessionDirs: (_workspacePath: string): string[] => {
    return [];
  },
  sessionFilePattern: undefined,

  buildLaunchCommand: (
    _sessionId: string,
    cwd: string,
  ): { command: string; args: string[]; env?: Record<string, string> } => {
    return { command: 'copilot', args: [], env: { PWD: cwd } };
  },
};
