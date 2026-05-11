/**
 * Playwright coverage for the right-hand style panel — focused on the new
 * Classes section, per-class declaration editing, and keyboard value-bump
 * behaviour. Runs against a small standalone harness (no full webview
 * bootstrap) so the panel is exercised in isolation.
 */
import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import * as path from 'node:path';
import type {
  ClassRuleBlock,
  ClassRuleDeclaration,
  ElementSelectionSnapshot,
  PanelCssEdit,
  PanelStyleEdit,
} from '../src/shared/protocol';

const harnessEntry = path.join(__dirname, 'stylePanelHarness/main.ts');
let bundledHarnessCache: string | null = null;

async function getHarnessBundle(): Promise<string> {
  if (bundledHarnessCache) return bundledHarnessCache;
  const result = await build({
    entryPoints: [harnessEntry],
    bundle: true,
    write: false,
    format: 'iife',
    target: ['es2022'],
    platform: 'browser',
    sourcemap: 'inline',
    logLevel: 'silent',
  });
  bundledHarnessCache = result.outputFiles[0].text;
  return bundledHarnessCache;
}

async function mountHarness(page: Page): Promise<void> {
  const bundle = await getHarnessBundle();
  await page.setContent(`<!doctype html>
<html>
  <head><style>
    body { background: #1e1e1e; color: #ccc; font-family: system-ui, sans-serif; margin: 0; }
    #host { display: flex; flex-direction: column; width: 340px; min-height: 100vh; }
  </style></head>
  <body><div id="host"></div></body>
</html>`);
  await page.addScriptTag({ content: bundle });
  await page.waitForFunction(() => typeof (window as { __testSetSelection?: unknown }).__testSetSelection === 'function');
}

interface BuildSelectionInput {
  classList?: string[];
  classCatalog?: string[];
  classRules?: Record<string, ClassRuleBlock[] | ClassRuleDeclaration[]>;
  inlineStyle?: string | null;
}

function buildClassRules(
  input: Record<string, ClassRuleBlock[] | ClassRuleDeclaration[]> = {},
): Record<string, ClassRuleBlock[]> {
  return Object.fromEntries(
    Object.entries(input).map(([className, rules]) => [
      className,
      rules.every(isClassRuleDeclaration)
        ? [{ selector: `.${className}`, declarations: rules }]
        : rules,
    ]),
  );
}

function isClassRuleDeclaration(value: ClassRuleBlock | ClassRuleDeclaration): value is ClassRuleDeclaration {
  return !('declarations' in value);
}

function buildSelection(input: BuildSelectionInput = {}): ElementSelectionSnapshot {
  return {
    documentVersion: 1,
    elementId: 7,
    tagName: 'div',
    domPath: 'body > div',
    selectorHints: ['.primary'],
    classList: input.classList ?? [],
    classCatalog: input.classCatalog ?? [],
    classRules: buildClassRules(input.classRules),
    textPreview: '',
    outerHtmlPreview: '<div></div>',
    rect: { x: 0, y: 0, width: 200, height: 40 },
    styles: {
      inlineStyle: input.inlineStyle ?? null,
      computed: {
        display: 'block',
        paddingTop: '0px',
        paddingRight: '0px',
        paddingBottom: '0px',
        paddingLeft: '0px',
        marginTop: '0px',
        marginRight: '0px',
        marginBottom: '0px',
        marginLeft: '0px',
        borderTopWidth: '0px',
        borderTopStyle: 'none',
        borderTopColor: 'rgb(0, 0, 0)',
        borderTopLeftRadius: '0px',
        backgroundColor: 'rgba(0, 0, 0, 0)',
        flexDirection: 'row',
        justifyContent: 'flex-start',
        alignItems: 'stretch',
        flexWrap: 'nowrap',
        rowGap: '0px',
        gridTemplateColumns: 'none',
        gridTemplateRows: 'none',
      },
    },
  };
}

async function setSelection(page: Page, snapshot: ElementSelectionSnapshot | null): Promise<void> {
  await page.evaluate((snap) => {
    (window as unknown as { __testSetSelection: (s: ElementSelectionSnapshot | null) => void }).__testSetSelection(snap);
  }, snapshot);
}

async function clearMessages(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __testClearMessages: () => void }).__testClearMessages();
  });
}

async function readMessages(page: Page): Promise<Array<PanelStyleEdit | PanelCssEdit>> {
  return page.evaluate(
    () => (window as unknown as { __testMessages: Array<PanelStyleEdit | PanelCssEdit> }).__testMessages,
  );
}

async function waitForLastMessage(
  page: Page,
  predicate: (msg: PanelStyleEdit | PanelCssEdit) => boolean,
): Promise<PanelStyleEdit | PanelCssEdit> {
  await page.waitForFunction(
    () => (window as unknown as { __testMessages: unknown[] }).__testMessages.length > 0,
  );
  const msgs = await readMessages(page);
  const found = [...msgs].reverse().find(predicate);
  if (!found) throw new Error(`No matching message. Got: ${JSON.stringify(msgs)}`);
  return found;
}

test.describe('side panel · classes', () => {
  test('renders applied classes as chips and offers catalog autocomplete', async ({ page }) => {
    await mountHarness(page);
    await setSelection(
      page,
      buildSelection({ classList: ['primary'], classCatalog: ['primary', 'card', 'hero'] }),
    );

    await expect(page.locator('.sp-chip')).toHaveCount(1);
    await expect(page.locator('.sp-chip-label')).toHaveText('primary');

    // Focus the add input → dropdown shows everything except already-applied.
    await page.locator('.sp-class-input').click();
    const items = page.locator('.sp-dropdown-item');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toHaveText('card');
    await expect(items.nth(1)).toHaveText('hero');
  });

  test('keyboard-selects a class from the dropdown and commits as a class attr', async ({ page }) => {
    await mountHarness(page);
    await setSelection(
      page,
      buildSelection({ classList: ['primary'], classCatalog: ['primary', 'card', 'hero'] }),
    );
    await clearMessages(page);

    await page.locator('.sp-class-input').click();
    await page.keyboard.press('ArrowDown'); // highlight 'hero' (index 1)
    await page.keyboard.press('Enter');

    const msg = await waitForLastMessage(page, (m) => m.type === 'panelStyleEdit');
    expect(msg).toMatchObject({
      type: 'panelStyleEdit',
      elementId: 7,
      attrs: { class: 'primary hero' },
    });
  });

  test('removing a chip commits a class attr without that token', async ({ page }) => {
    await mountHarness(page);
    await setSelection(page, buildSelection({ classList: ['primary', 'card'] }));
    await clearMessages(page);

    await page.locator('.sp-chip', { hasText: 'card' }).locator('.sp-chip-remove').click();

    const msg = await waitForLastMessage(page, (m) => m.type === 'panelStyleEdit');
    expect(msg).toMatchObject({ type: 'panelStyleEdit', attrs: { class: 'primary' } });
  });
});

test.describe('side panel · per-class declarations', () => {
  test('renders a section per applied class with editable rows', async ({ page }) => {
    await mountHarness(page);
    await setSelection(
      page,
      buildSelection({
        classList: ['primary'],
        classRules: {
          primary: [
            { property: 'padding', value: '8px', important: false },
            { property: 'color', value: '#4cb6ff', important: false },
          ],
        },
      }),
    );

    await expect(page.locator('.sp-classrule')).toHaveCount(1);
    await expect(page.locator('.sp-classrule-title')).toHaveText('.primary');
    await expect(page.locator('.sp-decl-row')).toHaveCount(2);
    await expect(page.locator('.sp-decl-prop').nth(0)).toHaveText('padding');
    await expect(page.locator('.sp-decl-value').nth(0)).toHaveValue('8px');
    await expect(page.locator('.sp-decl-prop').nth(1)).toHaveText('color');
    await expect(page.locator('.sp-decl-value').nth(1)).toHaveValue('#4cb6ff');
  });

  test('renders separate selector blocks and commits edits against that selector', async ({ page }) => {
    await mountHarness(page);
    await setSelection(
      page,
      buildSelection({
        classList: ['primary'],
        classRules: {
          primary: [
            {
              selector: '.primary',
              declarations: [{ property: 'padding', value: '8px', important: false }],
            },
            {
              selector: '.card > .primary',
              declarations: [{ property: 'color', value: '#4cb6ff', important: false }],
            },
          ],
        },
      }),
    );

    await expect(page.locator('.sp-classrule-count')).toHaveText('2');
    await expect(page.locator('.sp-classrule-selector').nth(0)).toHaveText('.primary');
    await expect(page.locator('.sp-classrule-selector').nth(1)).toHaveText('.card > .primary');
    await clearMessages(page);

    const contextualValue = page.locator('.sp-decl-value').nth(1);
    await contextualValue.fill('#ffffff');
    await contextualValue.press('Enter');

    const msg = await waitForLastMessage(page, (m) => m.type === 'panelCssEdit');
    expect(msg).toMatchObject({
      type: 'panelCssEdit',
      selector: '.card > .primary',
      property: 'color',
      value: '#ffffff',
    });
  });

  test('Enter on a manually edited value commits a panelCssEdit', async ({ page }) => {
    await mountHarness(page);
    await setSelection(
      page,
      buildSelection({
        classList: ['primary'],
        classRules: { primary: [{ property: 'padding', value: '8px', important: false }] },
      }),
    );
    await clearMessages(page);

    const valueInput = page.locator('.sp-decl-value').first();
    await valueInput.click();
    await valueInput.fill('12px');
    await page.keyboard.press('Enter');

    const msg = await waitForLastMessage(page, (m) => m.type === 'panelCssEdit');
    expect(msg).toMatchObject({
      type: 'panelCssEdit',
      selector: '.primary',
      property: 'padding',
      value: '12px',
    });
  });

  test('typing a declaration value commits without requiring blur', async ({ page }) => {
    await mountHarness(page);
    await setSelection(
      page,
      buildSelection({
        classList: ['primary'],
        classRules: { primary: [{ property: 'padding', value: '8px', important: false }] },
      }),
    );
    await clearMessages(page);

    const valueInput = page.locator('.sp-decl-value').first();
    await valueInput.click();
    await valueInput.fill('10px');

    const msg = await waitForLastMessage(page, (m) => m.type === 'panelCssEdit');
    expect(msg).toMatchObject({
      type: 'panelCssEdit',
      selector: '.primary',
      property: 'padding',
      value: '10px',
    });
    await expect(valueInput).toBeFocused();
  });

  test('× button on a declaration commits a removal (value=null)', async ({ page }) => {
    await mountHarness(page);
    await setSelection(
      page,
      buildSelection({
        classList: ['primary'],
        classRules: { primary: [{ property: 'padding', value: '8px', important: false }] },
      }),
    );
    await clearMessages(page);

    await page.locator('.sp-decl-remove').first().click();

    const msg = await waitForLastMessage(page, (m) => m.type === 'panelCssEdit');
    expect(msg).toMatchObject({
      type: 'panelCssEdit',
      selector: '.primary',
      property: 'padding',
      value: null,
    });
  });

  test('Add Property row commits a new declaration', async ({ page }) => {
    await mountHarness(page);
    await setSelection(
      page,
      buildSelection({
        classList: ['primary'],
        classRules: { primary: [{ property: 'padding', value: '8px', important: false }] },
      }),
    );
    await clearMessages(page);

    await page.locator('.sp-decl-add-prop').fill('margin');
    await page.locator('.sp-decl-add-value').fill('4px');
    await page.locator('.sp-decl-add-value').press('Enter');

    const msg = await waitForLastMessage(page, (m) => m.type === 'panelCssEdit');
    expect(msg).toMatchObject({
      type: 'panelCssEdit',
      selector: '.primary',
      property: 'margin',
      value: '4px',
    });
  });
});

test.describe('side panel · keyboard value bump', () => {
  async function setupWithValue(page: Page, value: string): Promise<void> {
    await mountHarness(page);
    await setSelection(
      page,
      buildSelection({
        classList: ['primary'],
        classRules: { primary: [{ property: 'padding', value, important: false }] },
      }),
    );
    await page.locator('.sp-decl-value').first().click();
    await clearMessages(page);
  }

  test('ArrowUp bumps a px integer by +1', async ({ page }) => {
    await setupWithValue(page, '8px');
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.sp-decl-value').first()).toHaveValue('9px');
    const msg = await waitForLastMessage(page, (m) => m.type === 'panelCssEdit');
    expect(msg).toMatchObject({ property: 'padding', value: '9px' });
  });

  test('ArrowDown bumps a px integer by −1', async ({ page }) => {
    await setupWithValue(page, '8px');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.sp-decl-value').first()).toHaveValue('7px');
  });

  test('Shift+ArrowUp bumps by +10', async ({ page }) => {
    await setupWithValue(page, '8px');
    await page.keyboard.press('Shift+ArrowUp');
    await expect(page.locator('.sp-decl-value').first()).toHaveValue('18px');
  });

  test('Alt+ArrowUp bumps a decimal em by +0.1', async ({ page }) => {
    await setupWithValue(page, '1.5em');
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page.locator('.sp-decl-value').first()).toHaveValue('1.6em');
    const msg = await waitForLastMessage(page, (m) => m.type === 'panelCssEdit');
    expect(msg).toMatchObject({ value: '1.6em' });
  });

  test('preserves the unit when bumping % / vh / fr / rem', async ({ page }) => {
    for (const initial of ['50%', '10vh', '1fr', '1.25rem']) {
      await setupWithValue(page, initial);
      await page.keyboard.press('ArrowUp');
      const expected = {
        '50%': '51%',
        '10vh': '11vh',
        '1fr': '2fr',
        '1.25rem': '2.25rem',
      }[initial];
      await expect(page.locator('.sp-decl-value').first()).toHaveValue(expected);
    }
  });

  test('bumps unitless numeric values (line-height, opacity)', async ({ page }) => {
    await setupWithValue(page, '1.2');
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page.locator('.sp-decl-value').first()).toHaveValue('1.3');
  });

  test('ArrowUp on a keyword (auto) does not bump and does not commit', async ({ page }) => {
    await setupWithValue(page, 'auto');
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.sp-decl-value').first()).toHaveValue('auto');
    // No commit message should have arrived from the keypress (bump declined).
    // Allow the harness a moment to flush, then assert empty.
    await page.waitForTimeout(50);
    const msgs = await readMessages(page);
    expect(msgs.filter((m) => m.type === 'panelCssEdit')).toHaveLength(0);
  });

  test('handles negative px values', async ({ page }) => {
    await setupWithValue(page, '-4px');
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.sp-decl-value').first()).toHaveValue('-3px');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.sp-decl-value').first()).toHaveValue('-5px');
  });
});
