//! Function-level analysis: what each file declares, and which of those
//! declarations call which others.
//!
//! tree-sitter gives us syntax, not types, so a call is only ever resolved by
//! *name*. Calls to an imported name resolve exactly, because the import graph
//! already tells us which file a specifier points at. Calls through a value we
//! would have to infer a type for — `obj.method()` — cannot be resolved that
//! way, and are reported as guesses rather than quietly dropped or presented as
//! fact. See `Confidence`.

use std::collections::HashMap;

use serde::Serialize;
use tree_sitter::Node as TsNode;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SymbolKind {
    Function,
    Method,
    Class,
}

#[derive(Debug, Serialize)]
pub struct Symbol {
    /// `src/auth.ts#requireUser`, unique across the project.
    pub id: String,
    /// The id of the file node this belongs to.
    pub file: String,
    pub name: String,
    pub kind: SymbolKind,
    /// The class a method belongs to, if any.
    pub container: Option<String>,
    pub exported: bool,
    /// 1-based line of the declaration.
    pub line: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    /// Bound to a declaration through a local scope or a resolved import.
    Resolved,
    /// Matched only by method name, because the receiver's type is unknown.
    Guess,
}

#[derive(Debug, Serialize)]
pub struct Call {
    pub source: String,
    pub target: String,
    pub confidence: Confidence,
}

/// What a single file declares, plus the lookups needed to resolve calls in it.
#[derive(Debug, Default)]
pub struct FileSymbols {
    pub symbols: Vec<Symbol>,
    /// Top-level declared name -> symbol id, for resolving unqualified calls.
    pub locals: HashMap<String, String>,
    /// Exported name -> symbol id. `default` is stored under "default".
    pub exports: HashMap<String, String>,
    /// Start byte of a declaration's node -> its symbol id, so the walker can
    /// tell which function it is currently inside.
    pub spans: HashMap<usize, String>,
    /// Start byte of a class body -> the class name, for `this.method()`.
    pub class_spans: HashMap<usize, String>,
    /// Class name -> (method name -> symbol id).
    pub methods: HashMap<String, HashMap<String, String>>,
}

fn field_text<'a>(node: TsNode, field: &str, src: &'a [u8]) -> Option<&'a str> {
    node.child_by_field_name(field)?.utf8_text(src).ok()
}

/// Is this declaration directly under an `export` statement?
fn is_exported(node: TsNode) -> bool {
    node.parent().is_some_and(|p| p.kind() == "export_statement")
}

fn symbol_id(file: &str, name: &str) -> String {
    format!("{file}#{name}")
}

/// Collect every function, method and class declared in one file.
pub fn collect_declarations(root: TsNode, src: &[u8], file: &str) -> FileSymbols {
    let mut out = FileSymbols::default();
    walk_declarations(root, src, file, &mut out);
    out
}

fn record(out: &mut FileSymbols, symbol: Symbol, node: TsNode, top_level: bool) {
    if top_level {
        out.locals.insert(symbol.name.clone(), symbol.id.clone());
    }
    if symbol.exported {
        out.exports.insert(symbol.name.clone(), symbol.id.clone());
    }
    out.spans.insert(node.start_byte(), symbol.id.clone());
    out.symbols.push(symbol);
}

fn walk_declarations(node: TsNode, src: &[u8], file: &str, out: &mut FileSymbols) {
    match node.kind() {
        "function_declaration" | "generator_function_declaration" => {
            if let Some(name) = field_text(node, "name", src) {
                let exported = is_exported(node);
                record(
                    out,
                    Symbol {
                        id: symbol_id(file, name),
                        file: file.to_owned(),
                        name: name.to_owned(),
                        kind: SymbolKind::Function,
                        container: None,
                        exported,
                        line: node.start_position().row + 1,
                    },
                    node,
                    true,
                );
            }
        }

        // `const handler = () => {}` and `const handler = function () {}`.
        "variable_declarator" => {
            let is_function = node
                .child_by_field_name("value")
                .is_some_and(|v| matches!(v.kind(), "arrow_function" | "function_expression"));
            if is_function {
                if let Some(name) = field_text(node, "name", src) {
                    // `export const a = ...` nests declarator inside declaration
                    // inside export_statement.
                    let exported = node
                        .parent()
                        .and_then(|p| p.parent())
                        .is_some_and(|p| p.kind() == "export_statement");
                    let value = node.child_by_field_name("value").unwrap();
                    let symbol = Symbol {
                        id: symbol_id(file, name),
                        file: file.to_owned(),
                        name: name.to_owned(),
                        kind: SymbolKind::Function,
                        container: None,
                        exported,
                        line: node.start_position().row + 1,
                    };
                    // Key the span on the function body, which is what the call
                    // walker will actually descend into.
                    out.spans.insert(value.start_byte(), symbol.id.clone());
                    record(out, symbol, node, true);
                }
            }
        }

        "class_declaration" => {
            if let Some(name) = field_text(node, "name", src) {
                let exported = is_exported(node);
                record(
                    out,
                    Symbol {
                        id: symbol_id(file, name),
                        file: file.to_owned(),
                        name: name.to_owned(),
                        kind: SymbolKind::Class,
                        container: None,
                        exported,
                        line: node.start_position().row + 1,
                    },
                    node,
                    true,
                );
                collect_methods(node, src, file, name, out);
            }
        }

        _ => {}
    }

    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        walk_declarations(child, src, file, out);
    }
}

fn collect_methods(class: TsNode, src: &[u8], file: &str, class_name: &str, out: &mut FileSymbols) {
    let Some(body) = class.child_by_field_name("body") else {
        return;
    };
    out.class_spans
        .insert(body.start_byte(), class_name.to_owned());

    let mut cursor = body.walk();
    for member in body.named_children(&mut cursor) {
        if member.kind() != "method_definition" {
            continue;
        }
        let Some(name) = field_text(member, "name", src) else {
            continue;
        };
        let id = symbol_id(file, &format!("{class_name}.{name}"));
        out.methods
            .entry(class_name.to_owned())
            .or_default()
            .insert(name.to_owned(), id.clone());
        out.spans.insert(member.start_byte(), id.clone());
        out.symbols.push(Symbol {
            id,
            file: file.to_owned(),
            name: name.to_owned(),
            kind: SymbolKind::Method,
            container: Some(class_name.to_owned()),
            exported: false,
            line: member.start_position().row + 1,
        });
    }
}

/// A name brought into a file by an import, and where it came from.
#[derive(Debug, Clone)]
pub enum Imported {
    /// `import { a as b } from "./x"` -> local `b` is `x`'s export `a`.
    Named { file: String, export: String },
    /// `import * as ns from "./x"` -> `ns.foo()` is `x`'s export `foo`.
    Namespace { file: String },
}

/// Map the local names introduced by this file's imports, given a resolver from
/// an import specifier to a project file id.
pub fn collect_imported_names(
    root: TsNode,
    src: &[u8],
    resolve: &dyn Fn(&str) -> Option<String>,
) -> HashMap<String, Imported> {
    let mut out = HashMap::new();
    walk_imports(root, src, resolve, &mut out);
    out
}

fn walk_imports(
    node: TsNode,
    src: &[u8],
    resolve: &dyn Fn(&str) -> Option<String>,
    out: &mut HashMap<String, Imported>,
) {
    if node.kind() == "import_statement" {
        if let Some(specifier) = node
            .child_by_field_name("source")
            .and_then(|s| string_text(s, src))
        {
            if let Some(file) = resolve(&specifier) {
                let mut cursor = node.walk();
                for child in node.named_children(&mut cursor) {
                    if child.kind() == "import_clause" {
                        read_import_clause(child, src, &file, out);
                    }
                }
            }
        }
    }

    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        walk_imports(child, src, resolve, out);
    }
}

fn read_import_clause(
    clause: TsNode,
    src: &[u8],
    file: &str,
    out: &mut HashMap<String, Imported>,
) {
    let mut cursor = clause.walk();
    for child in clause.named_children(&mut cursor) {
        match child.kind() {
            // `import Thing from "./x"`
            "identifier" => {
                if let Ok(local) = child.utf8_text(src) {
                    out.insert(
                        local.to_owned(),
                        Imported::Named {
                            file: file.to_owned(),
                            export: "default".to_owned(),
                        },
                    );
                }
            }
            // `import * as ns from "./x"`
            "namespace_import" => {
                let mut inner = child.walk();
                for part in child.named_children(&mut inner) {
                    if part.kind() == "identifier" {
                        if let Ok(local) = part.utf8_text(src) {
                            out.insert(
                                local.to_owned(),
                                Imported::Namespace {
                                    file: file.to_owned(),
                                },
                            );
                        }
                    }
                }
            }
            // `import { a, b as c } from "./x"`
            "named_imports" => {
                let mut inner = child.walk();
                for specifier in child.named_children(&mut inner) {
                    if specifier.kind() != "import_specifier" {
                        continue;
                    }
                    let Some(name) = field_text(specifier, "name", src) else {
                        continue;
                    };
                    let local = field_text(specifier, "alias", src).unwrap_or(name);
                    out.insert(
                        local.to_owned(),
                        Imported::Named {
                            file: file.to_owned(),
                            export: name.to_owned(),
                        },
                    );
                }
            }
            _ => {}
        }
    }
}

fn string_text(node: TsNode, src: &[u8]) -> Option<String> {
    let mut cursor = node.walk();
    let fragment = node
        .named_children(&mut cursor)
        .find(|c| c.kind() == "string_fragment")?;
    fragment.utf8_text(src).ok().map(str::to_owned)
}

/// Everything needed to turn a call site in one file into a symbol id.
pub struct CallContext<'a> {
    pub file: &'a FileSymbols,
    pub imports: &'a HashMap<String, Imported>,
    /// Exports of every file in the project, by file id.
    pub exports: &'a HashMap<String, HashMap<String, String>>,
    /// Method name -> symbol ids declaring it, across the project. Used only
    /// when the receiver's type is unknown.
    pub methods_by_name: &'a HashMap<String, Vec<String>>,
}

/// Walk a file's syntax tree and resolve the calls inside each declaration.
pub fn collect_calls(root: TsNode, src: &[u8], context: &CallContext) -> Vec<Call> {
    let mut calls = Vec::new();
    walk_calls(root, src, context, None, None, &mut calls);
    calls
}

fn walk_calls(
    node: TsNode,
    src: &[u8],
    context: &CallContext,
    enclosing: Option<&str>,
    class: Option<&str>,
    calls: &mut Vec<Call>,
) {
    // Entering a declaration makes it the owner of any call sites below, so a
    // call inside a nested callback is still attributed to the named function
    // that contains it.
    let enclosing = context
        .file
        .spans
        .get(&node.start_byte())
        .map(String::as_str)
        .or(enclosing);
    let class = context
        .file
        .class_spans
        .get(&node.start_byte())
        .map(String::as_str)
        .or(class);

    if node.kind() == "call_expression" {
        if let Some(caller) = enclosing {
            if let Some((target, confidence)) = resolve_callee(node, src, context, class) {
                if target != caller {
                    calls.push(Call {
                        source: caller.to_owned(),
                        target,
                        confidence,
                    });
                }
            }
        }
    }

    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        walk_calls(child, src, context, enclosing, class, calls);
    }
}

fn resolve_callee(
    call: TsNode,
    src: &[u8],
    context: &CallContext,
    class: Option<&str>,
) -> Option<(String, Confidence)> {
    let callee = call.child_by_field_name("function")?;

    match callee.kind() {
        "identifier" => {
            let name = callee.utf8_text(src).ok()?;
            // Something declared in this file wins over an import of the same name.
            if let Some(id) = context.file.locals.get(name) {
                return Some((id.clone(), Confidence::Resolved));
            }
            match context.imports.get(name)? {
                Imported::Named { file, export } => context
                    .exports
                    .get(file)?
                    .get(export)
                    .map(|id| (id.clone(), Confidence::Resolved)),
                // `ns()` — calling a namespace itself is not a thing.
                Imported::Namespace { .. } => None,
            }
        }

        "member_expression" => {
            let property = callee.child_by_field_name("property")?.utf8_text(src).ok()?;
            let object = callee.child_by_field_name("object")?;

            // `this.method()` inside a class resolves exactly.
            if object.kind() == "this" {
                let class = class?;
                return context
                    .file
                    .methods
                    .get(class)?
                    .get(property)
                    .map(|id| (id.clone(), Confidence::Resolved));
            }

            if object.kind() == "identifier" {
                let object_name = object.utf8_text(src).ok()?;

                // `ns.thing()` from `import * as ns` resolves exactly.
                if let Some(Imported::Namespace { file }) = context.imports.get(object_name) {
                    return context
                        .exports
                        .get(file)?
                        .get(property)
                        .map(|id| (id.clone(), Confidence::Resolved));
                }
            }

            // Otherwise the receiver's type is unknown. Fall back to matching the
            // method name across the project, and only when it is unambiguous —
            // linking every `get()` in a codebase to every other would be noise,
            // not information.
            let candidates = context.methods_by_name.get(property)?;
            match candidates.as_slice() {
                [only] => Some((only.clone(), Confidence::Guess)),
                _ => None,
            }
        }

        _ => None,
    }
}
