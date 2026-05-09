import type { EditCommit } from '../shared/protocol';

export function computeEdits(
  textNodeIds: number[],
  before: string[],
  after: string[],
): EditCommit['edits'] {
  const edits: EditCommit['edits'] = [];
  const len = Math.min(textNodeIds.length, before.length, after.length);
  for (let i = 0; i < len; i++) {
    if (before[i] !== after[i]) {
      edits.push({ nodeId: textNodeIds[i], newText: after[i] });
    }
  }
  return edits;
}
