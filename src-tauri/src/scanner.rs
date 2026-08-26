use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

use ignore::WalkBuilder;
use serde::Serialize;
use tree_sitter::{Node as TsNode, Parser, Tree};

use crate::symbols::{self, Call, CallContext, FileSymbols, Symbol};

#[derive(Debug, Serialize)]
pub struct GraphNode {
    /// Project-relative path, used as the stable identity of a file.
    pub id: String,
    /// Absolute path on disk.
    pub path: String,
    /// File name, shown on the node in the UI.
    pub label: String,
}

#[derive(Debug, Serialize)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
}

#[derive(Debug, Serialize)]
pub struct ProjectGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    /// Functions, methods and classes declared across the project.
    pub symbols: Vec<Symbol>,
    /// Resolved calls between them.
    pub calls: Vec<Call>,
}

/// Extensions we parse. Declaration files (`.d.ts`) come along for the ride since
/// they are plain `.ts`.
const SOURCE_EXTENSIONS: [&str; 2] = ["ts", "tsx"];

/// Extensions we try, in order, when an import specifier has no extension of its own.
/// Only source extensions appear here: an import of a `.json` or `.css` asset has no
/// node to point at, so it is dropped rather than resolved.
const RESOLVE_EXTENSIONS: [&str; 3] = ["ts", "tsx", "d.ts"];

/// Extensions a TS project may write in an import while meaning a TS file on disk
/// (NodeNext-style `./foo.js` -> `./foo.ts`).
const REWRITABLE_EXTENSIONS: [&str; 4] = ["js", "jsx", "mjs", "cjs"];

pub fn scan(root: &Path) -> Result<ProjectGraph, String> {
    let root = root
        .canonicalize()
        .map_err(|e| format!("cannot open {}: {e}", root.display()))?;
    if !root.is_dir() {
        return Err(format!("{} is not a directory", root.display()));
    }

    let files = collect_source_files(&root);

    // Every file we know about, so imports can only resolve to real project files.
    let known: HashSet<PathBuf> = files.iter().cloned().collect();

    let mut nodes = Vec::with_capacity(files.len());
    let mut ids: HashMap<PathBuf, String> = HashMap::with_capacity(files.len());
    for path in &files {
        let id = relative_id(&root, path);
        ids.insert(path.clone(), id.clone());
        nodes.push(GraphNode {
            id,
            path: path.to_string_lossy().into_owned(),
            label: path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
        });
    }

    // Parse every file once and keep the trees: the import pass, the declaration
    // pass and the call pass all read the same syntax.
    let mut parser = Parser::new();
    let mut parsed: Vec<(PathBuf, String, Tree)> = Vec::with_capacity(files.len());
    for path in &files {
        let Ok(source) = std::fs::read_to_string(path) else {
            // Unreadable or non-UTF-8 file: it still exists as a node, just without edges.
            continue;
        };

        let language = if path.extension().is_some_and(|e| e == "tsx") {
            tree_sitter_typescript::LANGUAGE_TSX
        } else {
            tree_sitter_typescript::LANGUAGE_TYPESCRIPT
        };
        if parser.set_language(&language.into()).is_err() {
            continue;
        }
        let Some(tree) = parser.parse(&source, None) else {
            continue;
        };
        parsed.push((path.clone(), source, tree));
    }

    let mut seen_edges: HashSet<(String, String)> = HashSet::new();
    let mut edges = Vec::new();

    for (path, source, tree) in &parsed {
        let mut specifiers = Vec::new();
        collect_specifiers(tree.root_node(), source.as_bytes(), &mut specifiers);

        let Some(source_id) = ids.get(path) else {
            continue;
        };
        let dir = path.parent().unwrap_or(&root);

        for specifier in specifiers {
            // Stage 1 resolves project-internal relative imports only; bare package
            // specifiers like `react` are intentionally dropped.
            if !is_relative(&specifier) {
                continue;
            }
            let Some(target) = resolve(dir, &specifier, &known) else {
                continue;
            };
            let Some(target_id) = ids.get(&target) else {
                continue;
            };
            if target_id == source_id {
                continue;
            }
            let key = (source_id.clone(), target_id.clone());
            if seen_edges.insert(key) {
                edges.push(GraphEdge {
                    source: source_id.clone(),
                    target: target_id.clone(),
                });
            }
        }
    }

    let (symbols, calls) = analyse_calls(&root, &parsed, &ids, &known);

    Ok(ProjectGraph {
        nodes,
        edges,
        symbols,
        calls,
    })
}

/// Second half of the scan: what each file declares, and which declarations call
/// which. Split out because it needs the whole project's exports before any one
/// file's calls can be resolved.
fn analyse_calls(
    root: &Path,
    parsed: &[(PathBuf, String, Tree)],
    ids: &HashMap<PathBuf, String>,
    known: &HashSet<PathBuf>,
) -> (Vec<Symbol>, Vec<Call>) {
    let mut per_file: HashMap<String, FileSymbols> = HashMap::new();
    for (path, source, tree) in parsed {
        let Some(file_id) = ids.get(path) else {
            continue;
        };
        per_file.insert(
            file_id.clone(),
            symbols::collect_declarations(tree.root_node(), source.as_bytes(), file_id),
        );
    }

    // A call to an imported name is resolved against the exports of the file the
    // import points at, so those have to be known project-wide up front.
    let exports: HashMap<String, HashMap<String, String>> = per_file
        .iter()
        .map(|(file, symbols)| (file.clone(), symbols.exports.clone()))
        .collect();

    let mut methods_by_name: HashMap<String, Vec<String>> = HashMap::new();
    for file_symbols in per_file.values() {
        for symbol in &file_symbols.symbols {
            if symbol.kind == symbols::SymbolKind::Method {
                methods_by_name
                    .entry(symbol.name.clone())
                    .or_default()
                    .push(symbol.id.clone());
            }
        }
    }

    let mut calls = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();

    for (path, source, tree) in parsed {
        let Some(file_id) = ids.get(path) else {
            continue;
        };
        let Some(file_symbols) = per_file.get(file_id) else {
            continue;
        };
        let dir = path.parent().unwrap_or(root);

        // Reuse the very same specifier resolution the import graph is built
        // from, so a call can never bind to a file an import would not.
        let resolve_specifier = |specifier: &str| -> Option<String> {
            if !is_relative(specifier) {
                return None;
            }
            ids.get(&resolve(dir, specifier, known)?).cloned()
        };
        let imports =
            symbols::collect_imported_names(tree.root_node(), source.as_bytes(), &resolve_specifier);

        let context = CallContext {
            file: file_symbols,
            imports: &imports,
            exports: &exports,
            methods_by_name: &methods_by_name,
        };
        for call in symbols::collect_calls(tree.root_node(), source.as_bytes(), &context) {
            if seen.insert((call.source.clone(), call.target.clone())) {
                calls.push(call);
            }
        }
    }

    let mut all_symbols: Vec<Symbol> = per_file
        .into_values()
        .flat_map(|file_symbols| file_symbols.symbols)
        .collect();
    all_symbols.sort_by(|a, b| a.id.cmp(&b.id));
    calls.sort_by(|a, b| (&a.source, &a.target).cmp(&(&b.source, &b.target)));

    (all_symbols, calls)
}

fn collect_source_files(root: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        // Honour `.gitignore` even when the chosen folder is not itself a git
        // repository, which is otherwise the crate's default.
        .require_git(false)
        .filter_entry(|entry| entry.file_name() != "node_modules")
        .build()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_some_and(|t| t.is_file()))
        .map(|entry| entry.into_path())
        .filter(|path| {
            path.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| SOURCE_EXTENSIONS.contains(&e))
        })
        .collect();
    files.sort();
    files
}

fn relative_id(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn is_relative(specifier: &str) -> bool {
    specifier.starts_with("./") || specifier.starts_with("../")
}

/// Resolve a relative import specifier to a file we actually walked, mirroring the
/// subset of Node/TS resolution that plain relative imports need.
fn resolve(dir: &Path, specifier: &str, known: &HashSet<PathBuf>) -> Option<PathBuf> {
    let base = normalize(&dir.join(specifier));

    // Specifier written with its extension, e.g. `./foo.ts`.
    if known.contains(&base) {
        return Some(base);
    }

    // `./foo` -> `./foo.ts`, `./foo.tsx`, ...
    for ext in RESOLVE_EXTENSIONS {
        let candidate = append_extension(&base, ext);
        if known.contains(&candidate) {
            return Some(candidate);
        }
    }

    // `./foo.js` -> `./foo.ts` (TS emits `.js` specifiers for `.ts` sources).
    if let Some(ext) = base.extension().and_then(|e| e.to_str()) {
        if REWRITABLE_EXTENSIONS.contains(&ext) {
            let stripped = base.with_extension("");
            for ext in RESOLVE_EXTENSIONS {
                let candidate = append_extension(&stripped, ext);
                if known.contains(&candidate) {
                    return Some(candidate);
                }
            }
        }
    }

    // `./foo` -> `./foo/index.ts`
    for ext in RESOLVE_EXTENSIONS {
        let candidate = append_extension(&base.join("index"), ext);
        if known.contains(&candidate) {
            return Some(candidate);
        }
    }

    None
}

/// `with_extension` would clobber the existing one, which breaks `foo.d.ts` and
/// any specifier containing a dot (`./use.auth` -> `./use.auth.ts`).
fn append_extension(path: &Path, ext: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".");
    name.push(ext);
    path.with_file_name(name)
}

/// Lexically resolve `.` and `..`. We cannot use `canonicalize` here because the
/// candidate usually does not exist yet, and it would also resolve symlinks away
/// from the paths the walker handed us.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push(component.as_os_str());
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Walk the syntax tree collecting import specifiers from `import`/`export ... from`
/// statements and `require(...)` calls.
fn collect_specifiers(node: TsNode, src: &[u8], out: &mut Vec<String>) {
    match node.kind() {
        // `import x from "y"`, `import "y"`, `import type { T } from "y"`,
        // and `export { x } from "y"` / `export * from "y"`.
        "import_statement" | "export_statement" => {
            if let Some(source) = node.child_by_field_name("source") {
                if let Some(text) = string_literal_text(source, src) {
                    out.push(text);
                }
            }
        }
        // `require("y")`
        "call_expression" => {
            let is_require = node
                .child_by_field_name("function")
                .filter(|f| f.kind() == "identifier")
                .and_then(|f| f.utf8_text(src).ok())
                .is_some_and(|name| name == "require");
            if is_require {
                if let Some(args) = node.child_by_field_name("arguments") {
                    let mut cursor = args.walk();
                    for arg in args.named_children(&mut cursor) {
                        if let Some(text) = string_literal_text(arg, src) {
                            out.push(text);
                            break;
                        }
                    }
                }
            }
        }
        _ => {}
    }

    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        collect_specifiers(child, src, out);
    }
}

/// Text inside a string literal, or `None` for a template string with substitutions
/// or any other non-literal expression.
fn string_literal_text(node: TsNode, src: &[u8]) -> Option<String> {
    match node.kind() {
        "string" => {
            let mut cursor = node.walk();
            let fragment = node
                .named_children(&mut cursor)
                .find(|c| c.kind() == "string_fragment");
            match fragment {
                Some(f) => f.utf8_text(src).ok().map(str::to_owned),
                // An empty string literal has no fragment child.
                None => Some(String::new()),
            }
        }
        "template_string" => {
            let mut cursor = node.walk();
            let children: Vec<TsNode> = node.named_children(&mut cursor).collect();
            match children.as_slice() {
                [] => Some(String::new()),
                [only] if only.kind() == "string_fragment" => {
                    only.utf8_text(src).ok().map(str::to_owned)
                }
                _ => None,
            }
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::fs;

    /// Build a project tree from `(relative path, contents)` pairs and scan it.
    pub(super) fn scan_fixture(files: &[(&str, &str)]) -> (ProjectGraph, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        for (path, contents) in files {
            let full = dir.path().join(path);
            fs::create_dir_all(full.parent().unwrap()).expect("mkdir");
            fs::write(&full, contents).expect("write");
        }
        let graph = scan(dir.path()).expect("scan");
        (graph, dir)
    }

    fn node_ids(graph: &ProjectGraph) -> BTreeSet<&str> {
        graph.nodes.iter().map(|n| n.id.as_str()).collect()
    }

    fn edge_pairs(graph: &ProjectGraph) -> BTreeSet<(&str, &str)> {
        graph
            .edges
            .iter()
            .map(|e| (e.source.as_str(), e.target.as_str()))
            .collect()
    }

    #[test]
    fn collects_ts_and_tsx_files_only() {
        let (graph, _dir) = scan_fixture(&[
            ("src/a.ts", ""),
            ("src/b.tsx", ""),
            ("src/c.js", ""),
            ("README.md", ""),
        ]);
        assert_eq!(node_ids(&graph), BTreeSet::from(["src/a.ts", "src/b.tsx"]));
    }

    #[test]
    fn skips_node_modules_and_gitignored_paths() {
        let (graph, _dir) = scan_fixture(&[
            (".gitignore", "generated/\n"),
            ("src/a.ts", ""),
            ("node_modules/pkg/index.ts", ""),
            ("generated/out.ts", ""),
        ]);
        assert_eq!(node_ids(&graph), BTreeSet::from(["src/a.ts"]));
    }

    #[test]
    fn links_relative_imports_and_ignores_bare_packages() {
        let (graph, _dir) = scan_fixture(&[
            (
                "src/app.ts",
                r#"
                import React from "react";
                import { helper } from "./util/helper";
                import "./styles";
                "#,
            ),
            ("src/util/helper.ts", ""),
            ("src/styles.ts", ""),
        ]);
        assert_eq!(
            edge_pairs(&graph),
            BTreeSet::from([
                ("src/app.ts", "src/util/helper.ts"),
                ("src/app.ts", "src/styles.ts"),
            ])
        );
    }

    #[test]
    fn resolves_parent_dirs_index_files_and_js_specifiers() {
        let (graph, _dir) = scan_fixture(&[
            (
                "src/feature/view.tsx",
                r#"
                import { api } from "../api.js";
                import { Widget } from "./widget";
                import shared from "../../shared";
                "#,
            ),
            ("src/api.ts", ""),
            ("src/feature/widget/index.tsx", ""),
            ("shared/index.ts", ""),
        ]);
        assert_eq!(
            edge_pairs(&graph),
            BTreeSet::from([
                ("src/feature/view.tsx", "src/api.ts"),
                ("src/feature/view.tsx", "src/feature/widget/index.tsx"),
                ("src/feature/view.tsx", "shared/index.ts"),
            ])
        );
    }

    #[test]
    fn collects_requires_type_imports_and_re_exports() {
        let (graph, _dir) = scan_fixture(&[
            (
                "src/index.ts",
                r#"
                import type { T } from "./types";
                export { thing } from "./thing";
                export * from "./star";
                const legacy = require("./legacy");
                "#,
            ),
            ("src/types.ts", ""),
            ("src/thing.ts", ""),
            ("src/star.ts", ""),
            ("src/legacy.ts", ""),
        ]);
        assert_eq!(
            edge_pairs(&graph),
            BTreeSet::from([
                ("src/index.ts", "src/types.ts"),
                ("src/index.ts", "src/thing.ts"),
                ("src/index.ts", "src/star.ts"),
                ("src/index.ts", "src/legacy.ts"),
            ])
        );
    }

    #[test]
    fn parses_tsx_generics_and_jsx_in_the_same_file() {
        // The TSX grammar must be used here, otherwise the JSX below fails to parse.
        let (graph, _dir) = scan_fixture(&[
            (
                "src/list.tsx",
                r#"
                import { Row } from "./row";
                export const List = () => <div><Row /></div>;
                "#,
            ),
            ("src/row.tsx", ""),
        ]);
        assert_eq!(
            edge_pairs(&graph),
            BTreeSet::from([("src/list.tsx", "src/row.tsx")])
        );
    }

    #[test]
    fn deduplicates_repeated_imports_and_drops_self_imports() {
        let (graph, _dir) = scan_fixture(&[
            (
                "src/a.ts",
                r#"
                import { one } from "./b";
                import { two } from "./b";
                import { self } from "./a";
                "#,
            ),
            ("src/b.ts", ""),
        ]);
        assert_eq!(edge_pairs(&graph), BTreeSet::from([("src/a.ts", "src/b.ts")]));
    }

    #[test]
    fn drops_imports_that_leave_the_project() {
        let (graph, _dir) = scan_fixture(&[(
            "src/a.ts",
            r#"import { x } from "./missing";
               import { y } from "../../outside/thing";"#,
        )]);
        assert!(graph.edges.is_empty(), "{:?}", graph.edges);
    }

    #[test]
    fn resolves_dotted_names_and_declaration_files() {
        let (graph, _dir) = scan_fixture(&[
            (
                "src/a.ts",
                r#"import "./use.auth";
                   import type { G } from "./globals";"#,
            ),
            ("src/use.auth.ts", ""),
            ("src/globals.d.ts", ""),
        ]);
        assert_eq!(
            edge_pairs(&graph),
            BTreeSet::from([
                ("src/a.ts", "src/use.auth.ts"),
                ("src/a.ts", "src/globals.d.ts"),
            ])
        );
    }

    #[test]
    fn ignores_dynamic_import_expressions() {
        // Out of scope for this stage: only static imports and `require` count.
        let (graph, _dir) = scan_fixture(&[
            ("src/a.ts", r#"const mod = await import("./lazy");"#),
            ("src/lazy.ts", ""),
        ]);
        assert!(graph.edges.is_empty(), "{:?}", graph.edges);
    }
}

#[cfg(test)]
mod call_tests {
    use super::tests::scan_fixture;
    use crate::symbols::Confidence;
    use std::collections::BTreeSet;

    fn calls(files: &[(&str, &str)]) -> BTreeSet<(String, String, &'static str)> {
        let (graph, _dir) = scan_fixture(files);
        graph
            .calls
            .iter()
            .map(|c| {
                (
                    c.source.clone(),
                    c.target.clone(),
                    match c.confidence {
                        Confidence::Resolved => "resolved",
                        Confidence::Guess => "guess",
                    },
                )
            })
            .collect()
    }

    fn symbol_ids(files: &[(&str, &str)]) -> BTreeSet<String> {
        let (graph, _dir) = scan_fixture(files);
        graph.symbols.iter().map(|s| s.id.clone()).collect()
    }

    #[test]
    fn declares_functions_arrows_classes_and_methods() {
        let ids = symbol_ids(&[(
            "src/a.ts",
            r#"
            export function alpha() {}
            const beta = () => {};
            export const gamma = function () {};
            export class Widget {
                render() {}
                private hide() {}
            }
            "#,
        )]);
        assert_eq!(
            ids,
            BTreeSet::from([
                "src/a.ts#Widget".to_string(),
                "src/a.ts#Widget.hide".to_string(),
                "src/a.ts#Widget.render".to_string(),
                "src/a.ts#alpha".to_string(),
                "src/a.ts#beta".to_string(),
                "src/a.ts#gamma".to_string(),
            ])
        );
    }

    #[test]
    fn resolves_calls_within_one_file() {
        assert_eq!(
            calls(&[(
                "src/a.ts",
                r#"
                function helper() {}
                export function main() { helper(); }
                "#,
            )]),
            BTreeSet::from([(
                "src/a.ts#main".into(),
                "src/a.ts#helper".into(),
                "resolved"
            )])
        );
    }

    #[test]
    fn resolves_calls_through_named_default_and_aliased_imports() {
        assert_eq!(
            calls(&[
                (
                    "src/main.ts",
                    r#"
                    import { fetchUser } from "./api";
                    import { save as persist } from "./api";
                    import connect from "./db";
                    export function run() {
                        fetchUser();
                        persist();
                        connect();
                    }
                    "#,
                ),
                (
                    "src/api.ts",
                    "export function fetchUser() {}\nexport function save() {}",
                ),
                ("src/db.ts", "export default function connect() {}"),
            ]),
            BTreeSet::from([
                ("src/main.ts#run".into(), "src/api.ts#fetchUser".into(), "resolved"),
                ("src/main.ts#run".into(), "src/api.ts#save".into(), "resolved"),
            ])
        );
    }

    #[test]
    fn resolves_namespace_imports_and_this_methods() {
        assert_eq!(
            calls(&[
                (
                    "src/main.ts",
                    r#"
                    import * as api from "./api";
                    export class Screen {
                        load() { api.fetchUser(); this.render(); }
                        render() {}
                    }
                    "#,
                ),
                ("src/api.ts", "export function fetchUser() {}"),
            ]),
            BTreeSet::from([
                (
                    "src/main.ts#Screen.load".into(),
                    "src/api.ts#fetchUser".into(),
                    "resolved"
                ),
                (
                    "src/main.ts#Screen.load".into(),
                    "src/main.ts#Screen.render".into(),
                    "resolved"
                ),
            ])
        );
    }

    #[test]
    fn attributes_calls_inside_callbacks_to_the_enclosing_function() {
        assert_eq!(
            calls(&[(
                "src/a.ts",
                r#"
                function tick() {}
                export function start() {
                    setInterval(() => { tick(); }, 10);
                }
                "#,
            )]),
            BTreeSet::from([("src/a.ts#start".into(), "src/a.ts#tick".into(), "resolved")])
        );
    }

    #[test]
    fn flags_method_calls_on_unknown_receivers_as_guesses() {
        // `service.refresh()` cannot be bound without knowing what `service` is.
        assert_eq!(
            calls(&[
                (
                    "src/a.ts",
                    r#"
                    import { service } from "./svc";
                    export function go() { service.refresh(); }
                    "#,
                ),
                ("src/svc.ts", "export class Service { refresh() {} }\nexport const service = new Service();"),
            ]),
            BTreeSet::from([(
                "src/a.ts#go".into(),
                "src/svc.ts#Service.refresh".into(),
                "guess"
            )])
        );
    }

    #[test]
    fn drops_ambiguous_method_names_rather_than_guessing_wildly() {
        // Two classes declare `get`, so a bare `thing.get()` could be either.
        let found = calls(&[
            (
                "src/a.ts",
                "export function go() { const thing = make(); thing.get(); }",
            ),
            ("src/b.ts", "export class Cache { get() {} }"),
            ("src/c.ts", "export class Store { get() {} }"),
        ]);
        assert!(
            found.iter().all(|(_, target, _)| !target.ends_with("#Cache.get")
                && !target.ends_with("#Store.get")),
            "{found:?}"
        );
    }

    #[test]
    fn ignores_calls_to_names_that_resolve_nowhere() {
        let found = calls(&[(
            "src/a.ts",
            r#"
            import { thing } from "react";
            export function go() { thing(); console.log("x"); missing(); }
            "#,
        )]);
        assert!(found.is_empty(), "{found:?}");
    }

    #[test]
    fn local_declarations_win_over_an_import_of_the_same_name() {
        assert_eq!(
            calls(&[
                (
                    "src/a.ts",
                    r#"
                    import { render } from "./other";
                    function render2() {}
                    function render() { render2(); }
                    export function go() { render(); }
                    "#,
                ),
                ("src/other.ts", "export function render() {}"),
            ]),
            BTreeSet::from([
                ("src/a.ts#go".into(), "src/a.ts#render".into(), "resolved"),
                ("src/a.ts#render".into(), "src/a.ts#render2".into(), "resolved"),
            ])
        );
    }
}
