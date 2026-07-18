/**
 * Registry of agents the host app can launch. Each entry knows the command to
 * run and how to check whether it's installed. `custom` lets a user run any
 * command line. Pure Node, no Electron — unit-testable.
 */
'use strict';
const { execFileSync } = require('child_process');

/** @type {Record<string, {id:string,name:string,file:string,args:string[],hint:string}>} */
const AGENTS = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    file: 'claude',
    args: [],
    hint: 'Install with: npm i -g @anthropic-ai/claude-code — then sign in or set ANTHROPIC_API_KEY.',
  },
  aider: {
    id: 'aider',
    name: 'Aider',
    file: 'aider',
    args: [],
    hint: 'Install with: pip install aider-install && aider-install',
  },
  codex: {
    id: 'codex',
    name: 'Codex CLI',
    file: 'codex',
    args: [],
    hint: 'Install the OpenAI Codex CLI and ensure `codex` is on your PATH.',
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini CLI',
    file: 'gemini',
    args: [],
    hint: 'Install the Gemini CLI and ensure `gemini` is on your PATH.',
  },
  shell: {
    id: 'shell',
    name: 'Shell',
    file: process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'bash'),
    args: [],
    hint: 'Always available.',
  },
};

/** Resolve a launch spec for a given agent id (or a custom command string). */
function resolve(id, customCommand) {
  if (id === 'custom') {
    const parts = String(customCommand || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) throw new Error('empty custom command');
    return { id: 'custom', name: parts[0], file: parts[0], args: parts.slice(1) };
  }
  const a = AGENTS[id];
  if (!a) throw new Error(`unknown agent: ${id}`);
  return { id: a.id, name: a.name, file: a.file, args: [...a.args] };
}

/** Is a command available on PATH? Uses `command -v` / `where`. */
function isInstalled(file) {
  try {
    if (process.platform === 'win32') {
      execFileSync('where', [file], { stdio: 'ignore' });
    } else {
      execFileSync('command', ['-v', file], { stdio: 'ignore', shell: '/bin/sh' });
    }
    return true;
  } catch {
    // Fall back to a PATH scan (execFileSync of a shell builtin can be flaky).
    return false;
  }
}

/** List agents with an `installed` flag, for the picker UI. */
function list() {
  return Object.values(AGENTS).map((a) => ({
    id: a.id,
    name: a.name,
    hint: a.hint,
    installed: a.id === 'shell' ? true : isInstalled(a.file),
  }));
}

module.exports = { AGENTS, resolve, isInstalled, list };
