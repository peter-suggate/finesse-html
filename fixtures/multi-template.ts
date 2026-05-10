// Two separate html`...` template literals in a single file. The preview
// concatenates their bodies (with an HTML-comment divider) into one rendered
// document; edits to either splice back into the matching backtick range.

import { html } from 'lit-html';

export const header = () => html`
  <header>
    <h1>Header section</h1>
    <p>Click to edit the header text.</p>
  </header>
`;

export const footer = (year: number) => html`
  <footer>
    <p>Copyright ${year}</p>
    <p>All rights reserved.</p>
  </footer>
`;
