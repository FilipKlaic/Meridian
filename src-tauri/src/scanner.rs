use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

use ignore::WalkBuilder;
use serde::Serialize;
use tree_sitter::{Node as TsNode, Parser};

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

    let mut parser = Parser::new();
    let mut seen_edges: HashSet<(String, String)> = HashSet::new();
    let mut edges = Vec::new();

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

    Ok(ProjectGraph { nodes, edges })
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
    fn scan_fixture(files: &[(&str, &str)]) -> (ProjectGraph, tempfile::TempDir) {
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
