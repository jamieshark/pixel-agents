import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HOOK_SCRIPTS_DIR } from '../../../constants.js';
import { COPILOT_HOOK_EVENTS, COPILOT_HOOK_SCRIPT_NAME, COPILOT_HOOKS_DIR, COPILOT_HOOKS_FILE_NAME } from './constants.js';

/** Returns the absolute path to the hook script installed in the user's home dir. */
function getHookScriptPath(): string {
  return path.join(os.homedir(), HOOK_SCRIPTS_DIR, COPILOT_HOOK_SCRIPT_NAME);
}

/** Returns the absolute path to the hooks config file in the workspace. */
function getHooksFilePath(workspaceCwd: string): string {
  return path.join(workspaceCwd, COPILOT_HOOKS_DIR, COPILOT_HOOKS_FILE_NAME);
}

/** Build a single hook entry for one event. */
function makeHookEntry(): { type: string; bash: string; powershell: string; timeoutSec: number } {
  const scriptPath = getHookScriptPath();
  const cmd = `node "${scriptPath}"`;
  return { type: 'command', bash: cmd, powershell: cmd, timeoutSec: 5 };
}

/** Check if Pixel Agents hooks are installed in the workspace. */
export function areHooksInstalled(workspaceCwd: string): boolean {
  return fs.existsSync(getHooksFilePath(workspaceCwd));
}

/**
 * Install Pixel Agents hook entries into <workspaceCwd>/.github/hooks/pixel-agents.json.
 * Creates the directory if needed. Overwrites any existing file.
 */
export function installHooks(workspaceCwd: string): void {
  const hooksFilePath = getHooksFilePath(workspaceCwd);
  const hooksDir = path.dirname(hooksFilePath);

  try {
    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }

    const hooks: Record<string, Array<{ type: string; bash: string; powershell: string; timeoutSec: number }>> = {};
    for (const event of COPILOT_HOOK_EVENTS) {
      hooks[event] = [makeHookEntry()];
    }

    const config = { version: 1, hooks };
    const tmpPath = hooksFilePath + '.pixel-agents-tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
    fs.renameSync(tmpPath, hooksFilePath);
    console.log(`[Pixel Agents] Copilot hooks installed at ${hooksFilePath}`);
  } catch (e) {
    console.error(`[Pixel Agents] Failed to install Copilot hooks: ${e}`);
  }
}

/** Remove the Pixel Agents hooks config file from the workspace. */
export function uninstallHooks(workspaceCwd: string): void {
  const hooksFilePath = getHooksFilePath(workspaceCwd);
  try {
    if (fs.existsSync(hooksFilePath)) {
      fs.unlinkSync(hooksFilePath);
      console.log(`[Pixel Agents] Copilot hooks removed from ${hooksFilePath}`);
    }
  } catch (e) {
    console.error(`[Pixel Agents] Failed to remove Copilot hooks: ${e}`);
  }
}

/** Copy the shipped Copilot hook script to ~/.pixel-agents/hooks/ */
export function copyHookScript(extensionPath: string): void {
  const src = path.join(extensionPath, 'dist', 'hooks', COPILOT_HOOK_SCRIPT_NAME);
  const dst = getHookScriptPath();
  const dstDir = path.dirname(dst);

  try {
    if (!fs.existsSync(dstDir)) {
      fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(src)) {
      console.warn(`[Pixel Agents] Copilot hook script not found at ${src}`);
      return;
    }
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o700);
    console.log(`[Pixel Agents] Copilot hook script installed at ${dst}`);
  } catch (e) {
    console.error(`[Pixel Agents] Failed to copy Copilot hook script: ${e}`);
  }
}
