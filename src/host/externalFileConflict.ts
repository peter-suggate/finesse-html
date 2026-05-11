export type ExternalFileDocumentState = 'clean' | 'dirty';

export type ExternalFileConflictDecision =
  | {
      action: 'noop';
      reason: 'text-matches';
      documentState: ExternalFileDocumentState;
    }
  | {
      action: 'prompt';
      reason: 'disk-text-differs';
      documentState: ExternalFileDocumentState;
    };

export interface ExternalFileConflictInput {
  diskText: string;
  documentText: string;
  isDirty: boolean;
}

export function decideExternalFileConflict({
  diskText,
  documentText,
  isDirty,
}: ExternalFileConflictInput): ExternalFileConflictDecision {
  const documentState: ExternalFileDocumentState = isDirty ? 'dirty' : 'clean';
  if (diskText === documentText) {
    return {
      action: 'noop',
      reason: 'text-matches',
      documentState,
    };
  }

  return {
    action: 'prompt',
    reason: 'disk-text-differs',
    documentState,
  };
}
