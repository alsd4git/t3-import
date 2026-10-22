# Synthetic terminal demo

Regenerate the terminal screenshots and short walkthrough GIF from the current
Ink UI:

Use a supported Node release with `npm ci` completed, `uv`, and either Menlo,
DejaVu Sans Mono or Liberation Mono installed. The renderer supports macOS and
Linux font locations; output glyphs can vary with the selected system font.

```sh
node scripts/demo/render.mjs
```

The runner uses the repository's installed Vitest and application dependencies.
Its temporary T3 database and OpenCode conversations are synthetic. The harness
stubs source discovery/loading and reconciliation previews, then drives the
real `ImportTui` through source selection, conversation statuses, destination,
and review. It stops at review and never confirms an import. No provider or
personal home-directory data is read, and no target outside a temporary
directory is written. Python Pillow is run in an ephemeral `uv` environment;
no project dependency is added.

Generated files:

- `assets/fork-demo.png`: conversation list showing new, syncable, current, and
  conflict states.
- `assets/fork-demo.gif`: 12-second walkthrough of OpenCode selection, those
  statuses, selection, destination, and safe pre-confirmation review.
- `assets/fork-*.txt`: plain-text frames captured from Ink for image rendering.

The status previews are fixed synthetic fixtures so the demo remains stable.
Destination and review copy come from the current TUI. Existing demo assets are
left untouched.
