# Third-party assets

kiln itself is MIT (see LICENSE). It vendors a few files so the canvas works
with no network access at runtime. Each keeps its own license:

| what | where | license |
|---|---|---|
| JetBrains Mono | `public/fonts/` | SIL Open Font License 1.1 |
| highlight.js | `public/vendor/hljs/` | BSD 3-Clause |
| marked | `public/vendor/marked/` | MIT |
| vscode-icons file icons | `public/vendor/vsicons/` | MIT |
| xterm.js + addons | installed from npm at `node_modules/@xterm/` | MIT |

The addon-unicode11 copy in `public/vendor/` is xterm's, served from the repo
rather than from `node_modules` so the page can load it directly.
