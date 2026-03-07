/**
 * LLM Provider — spawns Claude Code CLI directly in --print mode.
 *
 * The SDK query() function uses --input-format stream-json which hangs
 * after init on CLI ≥2.1.x. This provider bypasses the SDK and spawns
 * the CLI with -p (print) + --output-format stream-json instead, which
 * is proven to work reliably.
 */

import fs from 'node:fs';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import type { LLMProvider, StreamChatParams, FileAttachment } from 'claude-to-im/src/lib/bridge/host.js';
import type { PendingPermissions } from './permission-gateway.js';

import { sseEvent } from './sse-utils.js';

// ── Resume retry detection ──

function shouldRetryWithoutResume(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('exited with code 1') ||
    lower.includes('resuming session with different model') ||
    lower.includes('no such session') ||
    lower.includes('session not found') ||
    (lower.includes('resume') && lower.includes('session'))
  );
}

// ── Environment isolation ──

const ENV_WHITELIST = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LC_ALL', 'LC_CTYPE',
  'TMPDIR', 'TEMP', 'TMP',
  'TERM', 'COLORTERM',
  'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'SSH_AUTH_SOCK',
]);

const ENV_ALWAYS_STRIP = ['CLAUDECODE'];

export function buildSubprocessEnv(): Record<string, string> {
  const mode = process.env.CTI_ENV_ISOLATION || 'strict';
  const out: Record<string, string> = {};

  if (mode === 'inherit') {
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (ENV_ALWAYS_STRIP.includes(k)) continue;
      out[k] = v;
    }
  } else {
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (ENV_WHITELIST.has(k)) { out[k] = v; continue; }
      if (k.startsWith('CTI_')) { out[k] = v; continue; }
    }
    if (process.env.CTI_ANTHROPIC_PASSTHROUGH === 'true') {
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && k.startsWith('ANTHROPIC_')) out[k] = v;
      }
    }
    const runtime = process.env.CTI_RUNTIME || 'claude';
    if (runtime === 'codex' || runtime === 'auto') {
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && (k.startsWith('OPENAI_') || k.startsWith('CODEX_'))) out[k] = v;
      }
    }
  }

  return out;
}

// ── Claude CLI path resolution ──

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveClaudeCliPath(): string | undefined {
  const fromEnv = process.env.CTI_CLAUDE_CODE_EXECUTABLE;
  if (fromEnv && isExecutable(fromEnv)) return fromEnv;

  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? 'where claude' : 'which claude';
  try {
    const resolved = execSync(cmd, { encoding: 'utf-8', timeout: 3000 }).trim().split('\n')[0].replace(/\r/g, '');
    if (resolved && isExecutable(resolved)) return resolved;
  } catch {
    // not found in PATH
  }

  const candidates = isWindows
    ? [
        process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs\\claude\\claude.exe` : '',
        'C:\\Program Files\\claude\\claude.exe',
      ].filter(Boolean)
    : [
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
        `${process.env.HOME}/.npm-global/bin/claude`,
        `${process.env.HOME}/.local/bin/claude`,
      ];
  for (const p of candidates) {
    if (p && isExecutable(p)) return p;
  }

  return undefined;
}

// ── Permission mode mapping ──

function mapPermissionMode(mode?: string, autoApprove?: boolean): string {
  if (autoApprove) return 'bypassPermissions';
  switch (mode) {
    case 'plan': return 'plan';
    case 'default': return 'default';
    case 'acceptEdits': return 'acceptEdits';
    default: return 'acceptEdits';
  }
}

// ── Stream-JSON output parser ──

interface ParseState {
  emittedTextLen: number;
  lastMsgId: string;
  seenToolUseIds: Set<string>;
}

function handleCliJsonLine(
  obj: Record<string, unknown>,
  controller: ReadableStreamDefaultController<string>,
  state: ParseState,
): void {
  const type = obj.type as string;
  const subtype = obj.subtype as string | undefined;

  switch (type) {
    case 'system': {
      if (subtype === 'init') {
        controller.enqueue(sseEvent('status', {
          session_id: obj.session_id,
          model: obj.model,
        }));
      }
      break;
    }

    case 'assistant': {
      const msg = obj.message as Record<string, unknown> | undefined;
      if (!msg) break;
      const content = msg.content as Array<Record<string, unknown>> | undefined;
      if (!content) break;

      // Reset text tracking if this is a different message
      const msgId = (msg.id as string) || '';
      if (msgId && msgId !== state.lastMsgId) {
        state.emittedTextLen = 0;
        state.lastMsgId = msgId;
      }

      // Accumulate all text from content blocks
      let totalText = '';
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          totalText += block.text;
        }
      }

      // Emit text delta
      if (totalText.length > state.emittedTextLen) {
        const delta = totalText.slice(state.emittedTextLen);
        controller.enqueue(sseEvent('text', delta));
        state.emittedTextLen = totalText.length;
      }

      // Emit tool_use blocks (deduplicated)
      for (const block of content) {
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          if (!state.seenToolUseIds.has(block.id)) {
            state.seenToolUseIds.add(block.id);
            controller.enqueue(sseEvent('tool_use', {
              id: block.id,
              name: block.name,
              input: block.input,
            }));
          }
        }
      }
      break;
    }

    case 'user': {
      // Tool results from completed tool calls
      const msg = obj.message as Record<string, unknown> | undefined;
      const content = msg?.content as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            const text = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content ?? '');
            controller.enqueue(sseEvent('tool_result', {
              tool_use_id: block.tool_use_id,
              content: text,
              is_error: block.is_error || false,
            }));
          }
        }
      }
      // Reset text tracking for next assistant turn
      state.emittedTextLen = 0;
      state.lastMsgId = '';
      break;
    }

    case 'result': {
      if (subtype === 'success') {
        const usage = obj.usage as Record<string, number> | undefined;
        controller.enqueue(sseEvent('result', {
          session_id: obj.session_id,
          is_error: obj.is_error || false,
          usage: {
            input_tokens: usage?.input_tokens || 0,
            output_tokens: usage?.output_tokens || 0,
            cache_read_input_tokens: usage?.cache_read_input_tokens || 0,
            cache_creation_input_tokens: usage?.cache_creation_input_tokens || 0,
            cost_usd: (obj.total_cost_usd as number) || 0,
          },
        }));
      } else {
        const errors = Array.isArray(obj.errors)
          ? (obj.errors as string[]).join('; ')
          : 'Unknown error';
        controller.enqueue(sseEvent('error', errors));
      }
      break;
    }

    // Skip: hook_started, hook_response, auth_status, etc.
  }
}

// ── CLI process runner ──

function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  controller: ReadableStreamDefaultController<string>,
  abortController?: AbortController,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    });

    const state: ParseState = {
      emittedTextLen: 0,
      lastMsgId: '',
      seenToolUseIds: new Set(),
    };

    let buffer = '';

    if (abortController) {
      const onAbort = () => { child.kill(); };
      abortController.signal.addEventListener('abort', onAbort, { once: true });
      child.on('exit', () => {
        abortController.signal.removeEventListener('abort', onAbort);
      });
    }

    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          handleCliJsonLine(obj, controller, state);
        } catch {
          // Skip unparseable lines
        }
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      console.error('[llm-provider] CLI stderr:', chunk.toString('utf8').trim());
    });

    child.on('exit', (code) => {
      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const obj = JSON.parse(buffer);
          handleCliJsonLine(obj, controller, state);
        } catch { /* skip */ }
      }

      if (code === 0 || code === null) {
        resolve();
      } else {
        reject(new Error(`Claude Code process exited with code ${code}`));
      }
    });

    child.on('error', reject);
  });
}

// ── Provider class ──

export class SDKLLMProvider implements LLMProvider {
  private cliPath: string | undefined;
  private autoApprove: boolean;

  constructor(_pendingPerms: PendingPermissions, cliPath?: string, autoApprove = false) {
    this.cliPath = cliPath;
    this.autoApprove = autoApprove;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const cliPath = this.cliPath;
    const autoApprove = this.autoApprove;

    return new ReadableStream({
      start(controller) {
        (async () => {
          let resumeId = params.sdkSessionId || undefined;
          let retried = false;

          while (true) {
            try {
              const cleanEnv = buildSubprocessEnv();
              console.log('[llm-provider] Starting CLI (print mode), model:', params.model,
                'resume:', resumeId || 'none', 'cwd:', params.workingDirectory);

              // Determine command and base args
              const isJsPath = cliPath?.endsWith('.js') || cliPath?.endsWith('.mjs');
              const command = isJsPath ? 'node' : (cliPath || 'claude');
              const args: string[] = [command];
              if (isJsPath) args.push(cliPath!);

              // Core flags
              args.push(
                '--print',
                '--output-format', 'stream-json',
                '--verbose',
                '--include-partial-messages',
              );

              // Model
              if (params.model) {
                args.push('--model', params.model);
              }

              // Resume session
              if (resumeId) {
                args.push('--resume', resumeId);
              }

              // System prompt
              if (params.systemPrompt) {
                args.push('--system-prompt', params.systemPrompt);
              }

              // Permission mode
              args.push('--permission-mode', mapPermissionMode(params.permissionMode, autoApprove));

              // The prompt must come last (positional argument for -p)
              args.push(params.prompt);

              await runCli(
                args,
                params.workingDirectory || process.cwd(),
                cleanEnv,
                controller,
                params.abortController,
              );

              controller.close();
              return;
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);

              if (resumeId && !retried && shouldRetryWithoutResume(message)) {
                console.warn('[llm-provider] Resume failed, retrying without resume:', message);
                resumeId = undefined;
                retried = true;
                continue;
              }

              console.error('[llm-provider] CLI error:', err instanceof Error ? err.stack || err.message : err);
              try {
                controller.enqueue(sseEvent('error', message));
                controller.close();
              } catch {
                // Controller already closed
              }
              return;
            }
          }
        })().catch((err) => {
          console.error('[llm-provider] Unhandled error in streamChat:', err instanceof Error ? err.message : err);
        });
      },
    });
  }
}
