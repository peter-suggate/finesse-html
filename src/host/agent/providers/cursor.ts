import type { AgentElementRequest, AgentPageRequest, AgentProvider, AgentRunSink } from '../types';

export class CursorAgentProvider implements AgentProvider {
  readonly id = 'cursor';
  readonly label = 'Cursor Agent SDK';

  async runElementRequest(request: AgentElementRequest, sink: AgentRunSink): Promise<void> {
    await this.runRequest(
      request,
      sink,
      `Finesse: ${request.element.tagName} in ${request.element.workspaceRelativePath}`,
      buildCursorElementPrompt(request),
    );
  }

  async runPageRequest(request: AgentPageRequest, sink: AgentRunSink): Promise<void> {
    await this.runRequest(
      request,
      sink,
      `Finesse: improve ${request.page.workspaceRelativePath}`,
      buildCursorPagePrompt(request),
    );
  }

  private async runRequest(
    request: AgentElementRequest | AgentPageRequest,
    sink: AgentRunSink,
    name: string,
    prompt: string,
  ): Promise<void> {
    const apiKey = request.apiKey;
    if (!apiKey) {
      throw new Error(
        'Cursor Agent is not connected. Run "Finesse: Connect Cursor Agent", open the Cursor Dashboard, create a key in Integrations > User API Keys, then paste it into Finesse.',
      );
    }

    sink.status(`Starting ${this.label} (${request.model})`);
    const { Agent } = await import('@cursor/sdk');
    const agent = await Agent.create({
      apiKey,
      name,
      model: { id: request.model },
      local: { cwd: request.workspaceRoot },
    });

    try {
      const run = await agent.send(prompt);
      sink.status(`Run ${run.id} started`);
      // The Cursor SDK exposes no run-level abort. Best effort: stop consuming
      // the stream once the thread aborts so the host frees the active slot.
      // The remote run may keep going server-side; its late output is dropped
      // by the engine's epoch guard.
      for await (const event of run.stream()) {
        if (request.signal?.aborted) {
          throw makeAbortError();
        }
        const text = assistantTextFromEvent(event);
        if (text) sink.output(text);
      }
      if (request.signal?.aborted) throw makeAbortError();
      const result = await run.wait();
      sink.status(`Run ${result.status}${result.durationMs ? ` in ${result.durationMs}ms` : ''}`);
      if (result.result) sink.output(`\n${result.result}\n`);
    } finally {
      agent.close();
    }
  }
}

export function buildCursorElementPrompt(request: AgentElementRequest): string {
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
- Make the requested change in the repository.
- Treat the source range and hash as the primary identity for the selected element.
- Before editing, verify the current source slice still matches the target. If it does not, search by nearby context, DOM path, selector hints, and text preview.
- Keep the change tightly scoped to this element unless the user request clearly needs adjacent code.
- Preserve existing formatting and project conventions.
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

export function buildCursorPagePrompt(request: AgentPageRequest): string {
  const { page, userPrompt } = request;
  return `You are improving the current page opened in Finesse.

User request:
${userPrompt}

Current page:
- File: ${page.workspaceRelativePath}
- Current document version: ${page.documentVersion}
- Language: ${page.languageId}

Instructions:
- Make the requested improvement in the repository.
- Treat the current page as the primary target.
- Keep the change scoped to this page unless the user request clearly needs shared styles, assets, or adjacent files.
- Preserve existing formatting and project conventions.
- If the request is ambiguous, make a reasonable page-level improvement and explain what changed.

Current source:
\`\`\`${page.languageId}
${page.source}
\`\`\`
`;
}

function makeAbortError(): Error {
  const err = new Error('Cursor run aborted.');
  err.name = 'AbortError';
  return err;
}

function assistantTextFromEvent(event: unknown): string {
  if (!event || typeof event !== 'object') return '';
  const maybe = event as {
    type?: unknown;
    message?: { content?: Array<{ type?: unknown; text?: unknown }> };
  };
  if (maybe.type !== 'assistant' || !Array.isArray(maybe.message?.content)) return '';
  let text = '';
  for (const block of maybe.message.content) {
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
  }
  return text;
}
