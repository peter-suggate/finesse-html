import type { AgentElementRequest, AgentPageRequest, AgentProvider, AgentRunSink } from '../types';

/**
 * Claude Code provider — drives the Claude Agent SDK to act on the selected
 * element. Authentication is handled by the SDK: it picks up the user's
 * existing Claude Code login (subscription/OAuth) from `~/.claude/`, or
 * falls back to the `ANTHROPIC_API_KEY` env var. We surface a helpful error
 * if neither is available.
 */
export class ClaudeCodeAgentProvider implements AgentProvider {
  readonly id = 'claude-code';
  readonly label = 'Claude Code';

  async runElementRequest(request: AgentElementRequest, sink: AgentRunSink): Promise<void> {
    await this.runRequest(request, sink, buildClaudeElementPrompt(request));
  }

  async runPageRequest(request: AgentPageRequest, sink: AgentRunSink): Promise<void> {
    await this.runRequest(request, sink, buildClaudePagePrompt(request));
  }

  private async runRequest(
    request: AgentElementRequest | AgentPageRequest,
    sink: AgentRunSink,
    prompt: string,
  ): Promise<void> {
    sink.status(`Starting ${this.label} (${request.model || 'default model'})`);

    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const env: Record<string, string | undefined> = { ...process.env };
    if (request.apiKey && !env.ANTHROPIC_API_KEY) {
      env.ANTHROPIC_API_KEY = request.apiKey;
    }

    const iterator = sdk.query({
      prompt,
      options: {
        cwd: request.workspaceRoot,
        model: request.model || undefined,
        permissionMode: 'acceptEdits',
        allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append:
            'You are being driven by the Finesse VS Code extension to edit a single rendered HTML element. Stay tightly scoped to the target the user describes and prefer the smallest correct edit.',
        },
        env,
      },
    });

    try {
      for await (const message of iterator) {
        handleMessage(message, sink);
      }
    } catch (err) {
      throw normalizeClaudeError(err);
    }
  }
}

function handleMessage(message: unknown, sink: AgentRunSink): void {
  if (!message || typeof message !== 'object') return;
  const m = message as { type?: unknown };
  switch (m.type) {
    case 'system':
      handleSystem(message, sink);
      return;
    case 'assistant':
      handleAssistant(message, sink);
      return;
    case 'result':
      handleResult(message, sink);
      return;
  }
}

function handleSystem(message: unknown, sink: AgentRunSink): void {
  const m = message as { subtype?: unknown; apiKeySource?: string; model?: string };
  if (m.subtype !== 'init') return;
  if (m.apiKeySource === 'oauth') {
    sink.status(`Using Claude Code subscription${m.model ? ` · ${m.model}` : ''}`);
  } else if (m.apiKeySource === 'temporary') {
    sink.status(`Using ANTHROPIC_API_KEY${m.model ? ` · ${m.model}` : ''}`);
  } else if (typeof m.apiKeySource === 'string') {
    sink.status(`Using ${m.apiKeySource} credentials${m.model ? ` · ${m.model}` : ''}`);
  }
}

function handleAssistant(message: unknown, sink: AgentRunSink): void {
  const m = message as {
    message?: { content?: Array<{ type?: unknown; text?: unknown; name?: unknown; input?: unknown }> };
    error?: string;
  };
  if (m.error) {
    sink.status(`Assistant error: ${m.error}`);
  }
  const content = m.message?.content;
  if (!Array.isArray(content)) return;
  let buffer = '';
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      buffer += block.text;
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      const summary = summarizeToolUse(block.name, block.input);
      sink.status(`tool: ${summary}`);
    }
  }
  if (buffer) sink.output(buffer);
}

function summarizeToolUse(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return name;
  const i = input as { file_path?: unknown; command?: unknown; pattern?: unknown };
  if (typeof i.file_path === 'string') return `${name} ${i.file_path}`;
  if (typeof i.command === 'string') return `${name} ${truncate(i.command, 80)}`;
  if (typeof i.pattern === 'string') return `${name} ${truncate(i.pattern, 80)}`;
  return name;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function handleResult(message: unknown, sink: AgentRunSink): void {
  const m = message as {
    subtype?: string;
    is_error?: boolean;
    duration_ms?: number;
    result?: string;
    errors?: string[];
    total_cost_usd?: number;
  };
  if (m.subtype === 'success') {
    const cost = typeof m.total_cost_usd === 'number' ? ` · $${m.total_cost_usd.toFixed(4)}` : '';
    sink.status(`Done${m.duration_ms ? ` in ${m.duration_ms}ms` : ''}${cost}`);
    if (m.result) sink.output(`\n${m.result}\n`);
    return;
  }
  const reason = m.subtype ?? 'unknown';
  const detail = Array.isArray(m.errors) && m.errors.length > 0 ? `: ${m.errors.join('; ')}` : '';
  throw new Error(`Claude Code run failed (${reason})${detail}`);
}

function normalizeClaudeError(err: unknown): Error {
  const raw = err instanceof Error ? err : new Error(String(err));
  const text = raw.message.toLowerCase();
  if (
    text.includes('authentication_failed') ||
    text.includes('not authenticated') ||
    text.includes('unauthorized') ||
    text.includes('login') ||
    text.includes('api key')
  ) {
    return new Error(
      'Claude Code is not authenticated. Open a terminal, run `claude`, then `/login` to sign in with your subscription — or set ANTHROPIC_API_KEY.',
    );
  }
  if (text.includes('claude code') && text.includes('binary')) {
    return new Error(
      'Could not launch the Claude Code binary bundled with the SDK. Install Claude Code from https://claude.com/code and try again.',
    );
  }
  return raw;
}

export function buildClaudeElementPrompt(request: AgentElementRequest): string {
  const { element, userPrompt } = request;
  return `You are editing a rendered HTML element selected in Finesse.

User request:
${userPrompt}

Target element:
- File: ${element.workspaceRelativePath}
- Current document version: ${element.documentVersion}
- Element token: ${element.token}
- Tag: ${element.tagName}
- Element id: ${element.elementId}
- Block id: ${element.blockId ?? 'none'}
- Source range: line ${element.start.line}, column ${element.start.character} to line ${element.end.line}, column ${element.end.character}
- Source offsets: ${element.start.offset}..${element.end.offset}
- Source SHA-256: ${element.sourceHash}
- DOM path: ${element.domPath}
- Selector hints: ${element.selectorHints.length > 0 ? element.selectorHints.join(', ') : 'none'}
- Text preview: ${element.textPreview || '(empty)'}

Instructions:
- Make the requested change in the repository using the Edit tool.
- Treat the source range and hash as the primary identity for the selected element.
- Before editing, read the file and verify the current source slice still matches the target. If it does not, search by nearby context, DOM path, selector hints, and text preview.
- Keep the change tightly scoped to this element unless the user request clearly needs adjacent code.
- Preserve existing formatting and project conventions.
- Do not run tests, formatters, builds, or git commands unless the user explicitly asked.
- If the target is ambiguous or missing, stop and explain what needs to be reselected.

Selected source:
\`\`\`html
${element.source}
\`\`\`

Source immediately before the selection:
\`\`\`
${element.beforeContext}
\`\`\`

Source immediately after the selection:
\`\`\`
${element.afterContext}
\`\`\`

Rendered outerHTML preview:
\`\`\`html
${element.outerHtmlPreview}
\`\`\`
`;
}

export function buildClaudePagePrompt(request: AgentPageRequest): string {
  const { page, userPrompt } = request;
  return `You are improving the current page opened in Finesse.

User request:
${userPrompt}

Current page:
- File: ${page.workspaceRelativePath}
- Current document version: ${page.documentVersion}
- Language: ${page.languageId}

Instructions:
- Make the requested improvement in the repository using the Edit tool.
- Treat the current page as the primary target.
- Keep the change scoped to this page unless the user request clearly needs shared styles, assets, or adjacent files.
- Preserve existing formatting and project conventions.
- Do not run tests, formatters, builds, or git commands unless the user explicitly asked.
- If the request is ambiguous, make a reasonable page-level improvement and explain what changed.

Current source:
\`\`\`${page.languageId}
${page.source}
\`\`\`
`;
}
