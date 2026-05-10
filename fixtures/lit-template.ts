// A small lit-html-style template literal fixture for the Finesse preview.
// The host extracts the html`...` body, renders it as the iframe preview,
// and applies edits back into this source file with byte-perfect fidelity
// outside the edited text spans.

import { html } from 'lit-html';

export const greeting = (name: string) => html`
  <article class="card">
    <h2>Welcome to the demo</h2>
    <p>This text is editable. Click anywhere to begin.</p>
    <p>Hello ${name}! The interpolation locks just this paragraph.</p>
    <p>Plain paragraphs around an interpolation remain editable.</p>
  </article>
`;
