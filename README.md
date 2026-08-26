# Meridian

A desktop app for looking at how a TypeScript codebase fits together. Point it at a
project folder and it charts which files import which, which functions call which, and
shows you the source behind any of it — without leaving the app.

Built with [Tauri](https://tauri.app) (Rust backend, WebView frontend), parsing with
[tree-sitter](https://tree-sitter.github.io), rendering with
[React Flow](https://reactflow.dev) and [dagre](https://github.com/dagrejs/dagre).

## What it does

- **Import graph** — one node per `.ts`/`.tsx` file, one edge per internal import.
  Files are coloured by directory, so packages separate visually.
- **Call graph** — functions, methods and classes, anchored on one file at a time:
  everything it declares plus everything one hop away in either direction.
- **Source viewer** — click any node to read the code behind it, with a button to jump
  to the same line in VS Code.
- **Focus mode** — hovering a node dims everything it does not touch.
- **Scan cache** — results are stored in SQLite per project path, so reopening a
  project draws immediately instead of rescanning.

Edges follow the lanes dagre reserves for them, so lines route around boxes rather than
through them, and labels drop away as you zoom out instead of turning into mush.

## Running it

Requires [Node](https://nodejs.org) and a [Rust toolchain](https://rustup.rs), plus
Tauri's [system dependencies](https://tauri.app/start/prerequisites/) for your platform.

```bash
npm install
npm run tauri dev
```

To build a distributable app:

```bash
npm run tauri build
```

## Using it

**Open** picks a project folder, **Scan** charts it. Pick a file in the inspector on the
left — or with the command palette — and switch to the **Calls** tab to see its call
graph. Click any node to read its source.

| Shortcut | Action |
| --- | --- |
| `⌘K` | Command palette — jump to a file or run a command |
| `⌘B` | Show or hide the inspector |
| `⌘T` | Switch between the import and call graphs |
| `⌘O` | Open a project |
| `⌘R` | Rescan |
| `Esc` | Clear the selection, or close the source viewer |

## What it understands, and what it doesn't

This matters more than usual for a tool like this: a confidently-drawn incomplete
picture reads exactly like a complete one. So the limits are worth stating plainly.

**Imports.** Static `import` statements, `export ... from` re-exports, and `require()`
calls. Specifiers are resolved the way Node and TypeScript resolve them — extension
inference, `index` files, and NodeNext-style `./foo.js` meaning `./foo.ts`.

- Bare package imports (`react`, `lodash`) are deliberately skipped; only files inside
  the project become nodes.
- **`tsconfig.json` path aliases are not resolved.** A project importing `@/components`
  will show far fewer edges than it really has.
- Dynamic `import()` is not counted.

**Calls.** tree-sitter provides syntax, not types, so a call is resolved by name:

- A call to a locally declared name binds to that declaration.
- A call to an imported name binds through the import graph — named, default, aliased
  and namespace imports all work.
- `this.method()` binds within the enclosing class.
- Anything else is a method call on a value whose type is unknowable without a type
  checker. Those are matched on method name alone and shown as **guesses** — drawn
  dashed, and counted separately in the header. When the name is ambiguous, the edge is
  dropped rather than guessed at.

Expect a healthy proportion of guesses on class-heavy or dependency-injected code. If
that becomes limiting, the fix is a resolver backed by the TypeScript compiler API; the
graph shape would not change.

**Freshness.** A cached scan is not invalidated when files change on disk — hit
**Rescan** after editing. The source viewer is the exception: it re-reads and re-parses
the file every time, so the code you see is always current even when the graph is not.

TypeScript and TSX only, for now.

## How it works

A scan walks the project with the [`ignore`](https://docs.rs/ignore) crate, respecting
`.gitignore` and skipping `node_modules`, then parses each file once with tree-sitter.
That single parse feeds three passes: imports, declarations, and calls. Resolving calls
needs the whole project's exports first, so declarations are collected across every file
before any call is bound.

The frontend lays both graphs out with dagre and renders them with React Flow. Node
geometry — size, handle positions, measurements — is declared from the layout rather
than measured from the DOM, which keeps the first paint correct and makes rendering
independent of `ResizeObserver` timing.

```
src/                    React frontend
  App.tsx               workspace shell, tabs, shared selection state
  layout.ts             dagre layout, routing, node geometry
  callLayout.ts         the call graph, anchored on one file
  Inspector.tsx         file list, search, imports/importers
  CommandPalette.tsx    ⌘K
  SourceDrawer.tsx      the source viewer
src-tauri/src/          Rust backend
  scanner.rs            walking, import extraction and resolution
  symbols.rs            declarations and call resolution
  source.rs             reading a declaration back off disk
```

## Development

```bash
cd src-tauri && cargo test          # scanner, resolution and source-reading tests
npm run build                       # typecheck and build the frontend
```

There is a CLI for exercising the scanner without launching the app, which is the
quickest way to see what a real project produces:

```bash
cd src-tauri
cargo run --example scan -- /path/to/project
cargo run --example scan -- /path/to/project --json
```
