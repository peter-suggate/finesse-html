export type AgentProviderId = 'cursor';

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
  apiKey?: string;
  userPrompt: string;
  element: ElementSourceReference;
}

export interface AgentRunSink {
  status(message: string): void;
  output(message: string): void;
}

export interface AgentProvider {
  readonly id: AgentProviderId;
  readonly label: string;
  runElementRequest(request: AgentElementRequest, sink: AgentRunSink): Promise<void>;
}
