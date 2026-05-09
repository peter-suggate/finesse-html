# vscode-html-wysiwyg

Click any element in an HTML file. Edit the text. Source-perfect round-trip.

A VS Code / Cursor extension that opens an HTML file in a side panel, lets you click block-level text to edit it inline, and writes changes back to the source file with byte-perfect preservation of everything you didn't touch — comments, indentation, attribute quoting, all of it.

**Status:** design complete; implementation pending.

See [SPEC.md](./SPEC.md) for the full design. Phasing summary:

- **Phase 0** — repo scaffold + locked message protocol + fixtures.
- **Phase 1** — five parallel streams (extension host, HTTP server, parse5 walker, iframe instrumentation, webview shell).
- **Phase 2** — five parallel polish streams (hot-reload, template UX, settings, resource serving, a11y).
- **Phase 3** — Cursor Cmd-K passthrough, attribute editing, marketplace + Open VSX publishing.
