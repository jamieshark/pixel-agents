/**
 * Copilot CLI-specific constants. Kept separate from `server/src/constants.ts` so a
 * future single-provider `server/` build doesn't accidentally depend on Copilot
 * unless Copilot is the active provider.
 */

/** Output filename after esbuild compiles copilot-hook.ts to CJS */
export const COPILOT_HOOK_SCRIPT_NAME = 'copilot-hook.js';

/** Workspace-relative directory where Copilot loads hooks from */
export const COPILOT_HOOKS_DIR = '.github/hooks';

/** File name for the Pixel Agents hooks configuration */
export const COPILOT_HOOKS_FILE_NAME = 'pixel-agents.json';

/** Hook events to subscribe to in .github/hooks/pixel-agents.json */
export const COPILOT_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'Stop',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
] as const;
