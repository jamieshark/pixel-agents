/**
 * Copilot CLI transcript parser.
 *
 * Parses events.jsonl lines from ~/.copilot/session-state/<id>/events.jsonl
 * and emits the same webview messages as the Claude transcript parser.
 *
 * Copilot events are structured: { type: "tool.execution_start", data: {...}, ... }
 * This is cleaner than Claude's embedded tool_use/tool_result blocks — we get
 * explicit events for tool start/end, turn boundaries, and permissions.
 */

import * as path from 'path';
import type * as vscode from 'vscode';

import {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
  TOOL_DONE_DELAY_MS,
} from '../server/src/constants.js';
import {
  cancelPermissionTimer,
  cancelWaitingTimer,
  clearAgentActivity,
} from './timerManager.js';
import type { AgentState } from './types.js';

const PERMISSION_EXEMPT_TOOLS = new Set([
  'report_intent',
  'view',
  'grep',
  'glob',
  'web_fetch',
  'web_search',
  'list_files',
  'search_code',
  'get_file',
  'read_agent',
  'list_agents',
  'list_bash',
  'read_bash',
  'fetch_copilot_cli_documentation',
  'session_store_sql',
  'sql',
  'store_memory',
  'vote_memory',
  'ask_user',
  // GitHub MCP tools
  'github-mcp-server-get_file_contents',
  'github-mcp-server-search_code',
  'github-mcp-server-search_issues',
  'github-mcp-server-search_pull_requests',
  'github-mcp-server-list_issues',
  'github-mcp-server-list_pull_requests',
  'github-mcp-server-list_commits',
  'github-mcp-server-list_branches',
  'github-mcp-server-get_commit',
  'github-mcp-server-issue_read',
  'github-mcp-server-pull_request_read',
  'github-mcp-server-actions_list',
  'github-mcp-server-actions_get',
  'github-mcp-server-get_job_logs',
  'github-mcp-server-list_copilot_spaces',
  'github-mcp-server-get_copilot_space',
  'github-mcp-server-search_repositories',
  'github-mcp-server-search_users',
]);

const SUBAGENT_TOOL_NAMES = new Set(['task', 'skill']);

/** Format a Copilot tool name into a human-readable status line. */
export function formatCopilotToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  const base = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
  switch (toolName) {
    case 'bash':
      return `Running: ${truncate((inp.command as string) || '', BASH_COMMAND_DISPLAY_MAX_LENGTH)}`;
    case 'edit':
      return `Editing ${base(inp.path ?? inp.file_path)}`;
    case 'create':
      return `Writing ${base(inp.path ?? inp.file_path)}`;
    case 'view':
    case 'get_file':
      return `Reading ${base(inp.path ?? inp.file_path)}`;
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
    case 'task': {
      const desc = typeof inp.description === 'string' ? inp.description : '';
      return desc
        ? `Subtask: ${truncate(desc, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH)}`
        : 'Running subtask';
    }
    case 'skill':
      return `Using skill: ${(inp.skill as string) || ''}`;
    case 'ask_user':
      return 'Waiting for your answer';
    case 'report_intent':
      return (typeof inp.intent === 'string' ? inp.intent : '') || 'Thinking';
    default:
      return `Using ${toolName}`;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '\u2026' : s;
}

/**
 * Process a single JSONL line from a Copilot events.jsonl file.
 *
 * Event types handled:
 *   tool.execution_start     → agentToolStart
 *   tool.execution_complete  → agentToolDone
 *   assistant.turn_start     → cancel waiting, mark active
 *   assistant.turn_end       → clear tools, mark waiting
 *   permission.requested     → agentStatus: permission
 *   permission.completed     → clear permission
 *   subagent.started         → agentToolStart (sub-agent)
 *   subagent.completed       → agentToolDone (sub-agent)
 *   user.message             → reset turn state
 *   session.start            → (used for session discovery)
 */
export function processCopilotTranscriptLine(
  agentId: number,
  line: string,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;
  agent.lastDataAt = Date.now();
  agent.linesProcessed++;

  try {
    const event = JSON.parse(line);
    const eventType = event.type as string | undefined;
    const data = event.data as Record<string, unknown> | undefined;
    if (!eventType || !data) return;

    switch (eventType) {
      case 'tool.execution_start': {
        const toolCallId = data.toolCallId as string;
        const toolName = data.toolName as string;
        const args = data.arguments as Record<string, unknown> | undefined;
        if (!toolCallId || !toolName) return;

        // Skip report_intent — it's just metadata, not a real tool action
        if (toolName === 'report_intent') return;

        cancelWaitingTimer(agentId, waitingTimers);
        agent.isWaiting = false;
        agent.hadToolsInTurn = true;

        const status = formatCopilotToolStatus(toolName, args);
        agent.activeToolIds.add(toolCallId);
        agent.activeToolStatuses.set(toolCallId, status);
        agent.activeToolNames.set(toolCallId, toolName);

        webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
        webview?.postMessage({
          type: 'agentToolStart',
          id: agentId,
          toolId: toolCallId,
          status,
          toolName,
          permissionActive: agent.permissionSent,
        });

        // Start permission timer for non-exempt tools
        if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
          // Copilot has explicit permission events, so we don't need a timer —
          // but we still track non-exempt tools for the permission indicator
        }
        break;
      }

      case 'tool.execution_complete': {
        const toolCallId = data.toolCallId as string;
        if (!toolCallId) return;

        const toolName = agent.activeToolNames.get(toolCallId);

        // Clean up subagent state if this was a subagent-spawning tool
        if (toolName && SUBAGENT_TOOL_NAMES.has(toolName)) {
          agent.activeSubagentToolIds.delete(toolCallId);
          agent.activeSubagentToolNames.delete(toolCallId);
          webview?.postMessage({
            type: 'subagentClear',
            id: agentId,
            parentToolId: toolCallId,
          });
        }

        agent.activeToolIds.delete(toolCallId);
        agent.activeToolStatuses.delete(toolCallId);
        agent.activeToolNames.delete(toolCallId);

        const id = agentId;
        setTimeout(() => {
          webview?.postMessage({ type: 'agentToolDone', id, toolId: toolCallId });
        }, TOOL_DONE_DELAY_MS);
        break;
      }

      case 'assistant.turn_start': {
        cancelWaitingTimer(agentId, waitingTimers);
        agent.isWaiting = false;
        agent.hadToolsInTurn = false;
        webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
        break;
      }

      case 'assistant.turn_end': {
        cancelWaitingTimer(agentId, waitingTimers);
        cancelPermissionTimer(agentId, permissionTimers);

        // Clear all active tool state
        if (agent.activeToolIds.size > 0) {
          agent.activeToolIds.clear();
          agent.activeToolStatuses.clear();
          agent.activeToolNames.clear();
          agent.activeSubagentToolIds.clear();
          agent.activeSubagentToolNames.clear();
          webview?.postMessage({ type: 'agentToolsClear', id: agentId });
        }

        agent.isWaiting = true;
        agent.permissionSent = false;
        agent.hadToolsInTurn = false;
        webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'waiting' });
        break;
      }

      case 'permission.requested': {
        agent.permissionSent = true;
        webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'permission' });
        break;
      }

      case 'permission.completed': {
        agent.permissionSent = false;
        cancelPermissionTimer(agentId, permissionTimers);
        webview?.postMessage({ type: 'agentToolPermissionClear', id: agentId });
        webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
        break;
      }

      case 'user.message': {
        cancelWaitingTimer(agentId, waitingTimers);
        clearAgentActivity(agent, agentId, permissionTimers, webview);
        agent.hadToolsInTurn = false;
        break;
      }

      case 'subagent.started': {
        const toolCallId = data.toolCallId as string;
        const agentName = data.agentName as string;
        const agentDisplayName = data.agentDisplayName as string;
        if (!toolCallId) return;

        const status = agentDisplayName
          ? `Subtask: ${truncate(agentDisplayName, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH)}`
          : `Subtask: ${agentName || 'agent'}`;

        agent.activeToolIds.add(toolCallId);
        agent.activeToolStatuses.set(toolCallId, status);
        agent.activeToolNames.set(toolCallId, 'task');

        webview?.postMessage({
          type: 'agentToolStart',
          id: agentId,
          toolId: toolCallId,
          status,
          toolName: 'task',
          permissionActive: false,
        });
        break;
      }

      case 'subagent.completed': {
        const toolCallId = data.toolCallId as string;
        if (!toolCallId) return;

        agent.activeSubagentToolIds.delete(toolCallId);
        agent.activeSubagentToolNames.delete(toolCallId);
        webview?.postMessage({
          type: 'subagentClear',
          id: agentId,
          parentToolId: toolCallId,
        });

        agent.activeToolIds.delete(toolCallId);
        agent.activeToolStatuses.delete(toolCallId);
        agent.activeToolNames.delete(toolCallId);

        setTimeout(() => {
          webview?.postMessage({ type: 'agentToolDone', id: agentId, toolId: toolCallId });
        }, TOOL_DONE_DELAY_MS);
        break;
      }

      // Ignore these — they're informational only
      case 'session.start':
      case 'session.model_change':
      case 'system.message':
      case 'system.notification':
      case 'session.plan_changed':
      case 'assistant.message':
      case 'hook.start':
      case 'hook.end':
        break;

      default:
        // Silently ignore unknown event types
        break;
    }
  } catch {
    // Ignore malformed lines
  }
}
