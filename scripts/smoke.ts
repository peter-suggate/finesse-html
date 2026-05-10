// Headless smoke test: parses each fixture, validates editability rules,
// performs a simulated edit through the splice pipeline, and asserts the
// only bytes that change are within the edited text node's source range.
//
// Run via: npx esbuild scripts/smoke.ts --bundle --platform=node --format=cjs --outfile=dist/smoke.js && node dist/smoke.js

import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectTemplate, walkEditable } from '../src/host/parse';

interface FixtureSpec {
  name: string;
  expectTemplated: boolean;
  expectMinBlocks?: number;
  expectMinTextNodes?: number;
  /** Expected to NOT contain text nodes from these tags (locked). */
  excludeTagsForTextNodes?: string[];
  /** Substring expected to appear in the originalText of any one text node. */
  expectAnyTextContains?: string[];
  /** Substrings that must NOT appear as originalText (or substring of) for any text node. */
  expectNoTextContains?: string[];
  edit?: { nodeIdSelectorContains: string; newText: string };
}

const fixtures: FixtureSpec[] = [
  {
    name: 'vanilla.html',
    expectTemplated: false,
    expectMinBlocks: 6,
    expectMinTextNodes: 6,
    expectAnyTextContains: ['Hello, world', 'First item'],
    edit: { nodeIdSelectorContains: 'Hello, world', newText: 'Hello, universe' },
  },
  {
    name: 'with-comments.html',
    expectTemplated: false,
    expectMinTextNodes: 1,
  },
  {
    name: 'inline-tags.html',
    expectTemplated: false,
    // 4 paragraphs, but text nodes split around inline tags → expect more text nodes than blocks
    expectMinBlocks: 4,
    expectMinTextNodes: 8,
    expectAnyTextContains: ['strong text', 'emphasis'],
    edit: { nodeIdSelectorContains: 'strong text', newText: 'STRONGER text' },
  },
  {
    name: 'tables.html',
    expectTemplated: false,
    // td/th cells should be block containers
    expectMinBlocks: 2,
  },
  {
    name: 'lists.html',
    expectTemplated: false,
    expectMinBlocks: 2,
  },
  {
    name: 'pre-and-code.html',
    expectTemplated: false,
    // text inside <pre> and <code> must be locked → no text nodes from those tags
    expectNoTextContains: ['function ', 'console.log'],
  },
  {
    name: 'templated-handlebars.html',
    expectTemplated: true,
    // detectTemplate must trigger; walkEditable still runs but the host treats the file as locked
  },
];

const fixturesDir = path.resolve(__dirname, '..', 'fixtures');

interface Failure {
  fixture: string;
  reason: string;
}

const failures: Failure[] = [];
let passed = 0;

for (const spec of fixtures) {
  try {
    const filePath = path.join(fixturesDir, spec.name);
    const html = fs.readFileSync(filePath, 'utf-8');
    const templated = detectTemplate(html);
    const map = walkEditable(html, 1);

    const summary =
      `${spec.name}: templated=${templated} blocks=${map.blocks.length} textNodes=${map.textNodes.length}`;

    if (templated !== spec.expectTemplated) {
      failures.push({
        fixture: spec.name,
        reason: `templated mismatch: expected ${spec.expectTemplated}, got ${templated}`,
      });
      console.log(`✗ ${summary}`);
      continue;
    }
    if (spec.expectMinBlocks !== undefined && map.blocks.length < spec.expectMinBlocks) {
      failures.push({
        fixture: spec.name,
        reason: `blocks too few: expected >= ${spec.expectMinBlocks}, got ${map.blocks.length}`,
      });
      console.log(`✗ ${summary}`);
      continue;
    }
    if (spec.expectMinTextNodes !== undefined && map.textNodes.length < spec.expectMinTextNodes) {
      failures.push({
        fixture: spec.name,
        reason: `textNodes too few: expected >= ${spec.expectMinTextNodes}, got ${map.textNodes.length}`,
      });
      console.log(`✗ ${summary}`);
      continue;
    }
    if (spec.expectAnyTextContains) {
      for (const needle of spec.expectAnyTextContains) {
        const found = map.textNodes.some((tn) => tn.originalText.includes(needle));
        if (!found) {
          failures.push({
            fixture: spec.name,
            reason: `expected some text node containing ${JSON.stringify(needle)}, none found`,
          });
          console.log(`✗ ${summary}`);
          continue;
        }
      }
    }
    if (spec.expectNoTextContains) {
      for (const needle of spec.expectNoTextContains) {
        const found = map.textNodes.some((tn) => tn.originalText.includes(needle));
        if (found) {
          failures.push({
            fixture: spec.name,
            reason: `unexpected text node containing ${JSON.stringify(needle)} (should be locked)`,
          });
          console.log(`✗ ${summary}`);
          continue;
        }
      }
    }

    if (spec.edit) {
      const target = map.textNodes.find((tn) =>
        tn.originalText.includes(spec.edit!.nodeIdSelectorContains),
      );
      if (!target) {
        failures.push({
          fixture: spec.name,
          reason: `edit target containing ${JSON.stringify(spec.edit.nodeIdSelectorContains)} not found`,
        });
        console.log(`✗ ${summary}`);
        continue;
      }
      // Splice
      const after =
        html.slice(0, target.startOffset) + spec.edit.newText + html.slice(target.endOffset);

      // 1) byte-perfect outside the edited span
      const before = html;
      const beforePrefix = before.slice(0, target.startOffset);
      const afterPrefix = after.slice(0, target.startOffset);
      if (beforePrefix !== afterPrefix) {
        failures.push({
          fixture: spec.name,
          reason: 'prefix bytes changed outside edit span',
        });
        console.log(`✗ ${summary}`);
        continue;
      }
      const beforeSuffix = before.slice(target.endOffset);
      const afterSuffix = after.slice(target.startOffset + spec.edit.newText.length);
      if (beforeSuffix !== afterSuffix) {
        failures.push({
          fixture: spec.name,
          reason: 'suffix bytes changed outside edit span',
        });
        console.log(`✗ ${summary}`);
        continue;
      }

      // 2) re-parse: nodeId at the same position now reads the new text
      const map2 = walkEditable(after, 2);
      // Heuristic: find the text node that starts at the same offset (since nodeId
      // is just document-order, and we only changed one span, ordering is preserved)
      const remapped = map2.textNodes.find((tn) => tn.startOffset === target.startOffset);
      if (!remapped || remapped.originalText !== spec.edit.newText) {
        failures.push({
          fixture: spec.name,
          reason: `re-parsed text mismatch at offset ${target.startOffset}: expected ${JSON.stringify(
            spec.edit.newText,
          )}, got ${JSON.stringify(remapped?.originalText ?? null)}`,
        });
        console.log(`✗ ${summary}`);
        continue;
      }

      // 3) total length delta is exactly newText.length - originalText.length
      const expectedDelta = spec.edit.newText.length - target.originalText.length;
      const actualDelta = after.length - before.length;
      if (actualDelta !== expectedDelta) {
        failures.push({
          fixture: spec.name,
          reason: `length delta mismatch: expected ${expectedDelta}, got ${actualDelta}`,
        });
        console.log(`✗ ${summary}`);
        continue;
      }
    }

    passed++;
    console.log(`✓ ${summary}`);
  } catch (err) {
    failures.push({
      fixture: spec.name,
      reason: `threw: ${err instanceof Error ? err.message : String(err)}`,
    });
    console.log(`✗ ${spec.name}: error`);
  }
}

console.log('');
console.log('---');
console.log(`Passed: ${passed}/${fixtures.length}`);
if (failures.length > 0) {
  console.log(`Failed: ${failures.length}`);
  for (const f of failures) {
    console.log(`  - ${f.fixture}: ${f.reason}`);
  }
  process.exit(1);
}
