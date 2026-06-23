export type AgentProviderId = 'cursor' | 'claude-code';

export const ALL_AGENT_PROVIDER_IDS: readonly AgentProviderId[] = ['cursor', 'claude-code'];

export function isAgentProviderId(value: unknown): value is AgentProviderId {
  return value === 'cursor' || value === 'claude-code';
}

export interface SourcePosition {
  offset: number;
  line: number;
  character: number;
}

export interface ElementSourceReference {
  token: string;
  workspaceRelativePath: string;
  documentVersion: number;
  tagName: string;
  elementId: number;
  blockId?: number;
  sourceHash: string;
  start: SourcePosition;
  end: SourcePosition;
  source: string;
  beforeContext: string;
  afterContext: string;
  domPath: string;
  selectorHints: string[];
  textPreview: string;
  outerHtmlPreview: string;
}

export interface AgentElementRequest {
  providerId: AgentProviderId;
  workspaceRoot: string;
  model: string;
  /** Provider API key, if one is required. Claude Code can run without one when the user has logged in via the Claude CLI. */
  apiKey?: string;
  userPrompt: string;
  element: ElementSourceReference;
  /** Aborts the run when the owning edit thread is paused/restarted/removed. */
  signal?: AbortSignal;
}

export interface PageSourceReference {
  workspaceRelativePath: string;
  documentVersion: number;
  languageId: string;
  source: string;
}

export interface AgentPageRequest {
  providerId: AgentProviderId;
  workspaceRoot: string;
  model: string;
  /** Provider API key, if one is required. Claude Code can run without one when the user has logged in via the Claude CLI. */
  apiKey?: string;
  userPrompt: string;
  page: PageSourceReference;
  /** Aborts the run when the owning edit thread is paused/restarted/removed. */
  signal?: AbortSignal;
}

export interface AgentRunSink {
  status(message: string): void;
  output(message: string): void;
}

export interface AgentProvider {
  readonly id: AgentProviderId;
  readonly label: string;
  runElementRequest(request: AgentElementRequest, sink: AgentRunSink): Promise<void>;
  runPageRequest(request: AgentPageRequest, sink: AgentRunSink): Promise<void>;
}
