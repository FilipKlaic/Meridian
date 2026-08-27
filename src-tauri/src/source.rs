//! Reading source back off disk for the viewer.
//!
//! Nothing here is cached. The scan may be hours old, so a stored line range
//! would happily point at whatever now occupies those lines — showing the wrong
//! code with total confidence. Re-parsing the one file being looked at costs
//! about a millisecond and cannot drift.

use std::path::Path;

use serde::Serialize;
use tree_sitter::Parser;

use crate::symbols;

/// A very long file is not worth streaming into the webview in one go.
const MAX_WHOLE_FILE_LINES: usize = 3000;

#[derive(Debug, Serialize)]
pub struct SourceView {
    pub text: String,
    /// 1-based, inclusive, so the viewer can number lines as the file does.
    pub start_line: usize,
    pub end_line: usize,
    /// True when a long file was cut short.
    pub truncated: bool,
}

/// Read a whole file, or just one declaration in it.
pub fn read(
    path: &Path,
    name: Option<&str>,
    container: Option<&str>,
) -> Result<SourceView, String> {
    let source = std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;

    let Some(name) = name else {
        return Ok(whole_file(source));
    };

    let language = if path.extension().is_some_and(|e| e == "tsx") {
        tree_sitter_typescript::LANGUAGE_TSX
    } else {
        tree_sitter_typescript::LANGUAGE_TYPESCRIPT
    };

    let mut parser = Parser::new();
    parser
        .set_language(&language.into())
        .map_err(|e| format!("cannot load the TypeScript grammar: {e}"))?;
    let tree = parser
        .parse(&source, None)
        .ok_or_else(|| format!("cannot parse {}", path.display()))?;

    let declaration =
        symbols::locate_declaration(tree.root_node(), source.as_bytes(), name, container)
            .ok_or_else(|| {
                let what = match container {
                    Some(class) => format!("{class}.{name}"),
                    None => name.to_owned(),
                };
                // The file is readable and parses, so the declaration has been
                // renamed or removed since the scan.
                format!("{what} is no longer declared in this file — rescan to update the graph")
            })?;

    Ok(SourceView {
        text: source[declaration.start_byte..declaration.end_byte].to_owned(),
        start_line: declaration.start_line,
        end_line: declaration.end_line,
        truncated: false,
    })
}

fn whole_file(source: String) -> SourceView {
    let total = source.lines().count();
    if total <= MAX_WHOLE_FILE_LINES {
        return SourceView {
            text: source,
            start_line: 1,
            end_line: total.max(1),
            truncated: false,
        };
    }

    let text = source
        .lines()
        .take(MAX_WHOLE_FILE_LINES)
        .collect::<Vec<_>>()
        .join("\n");
    SourceView {
        text,
        start_line: 1,
        end_line: MAX_WHOLE_FILE_LINES,
        truncated: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(dir: &tempfile::TempDir, name: &str, contents: &str) -> std::path::PathBuf {
        let path = dir.path().join(name);
        fs::write(&path, contents).expect("write");
        path
    }

    const SAMPLE: &str = r#"import { x } from "./x";

export function alpha(a: number) {
  return a + 1;
}

const beta = () => {
  return 2;
};

export class Store {
  add(item: string) {
    this.items.push(item);
  }
  clear() {}
}
"#;

    #[test]
    fn reads_an_exported_function_with_its_export_keyword() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "a.ts", SAMPLE);
        let view = read(&path, Some("alpha"), None).expect("read");
        assert_eq!(
            view.text,
            "export function alpha(a: number) {\n  return a + 1;\n}"
        );
        assert_eq!((view.start_line, view.end_line), (3, 5));
    }

    #[test]
    fn reads_an_arrow_function_including_its_binding() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "a.ts", SAMPLE);
        let view = read(&path, Some("beta"), None).expect("read");
        assert_eq!(view.text, "const beta = () => {\n  return 2;\n};");
        assert_eq!((view.start_line, view.end_line), (7, 9));
    }

    #[test]
    fn reads_a_method_out_of_its_class() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "a.ts", SAMPLE);
        let view = read(&path, Some("add"), Some("Store")).expect("read");
        assert_eq!(
            view.text,
            "add(item: string) {\n    this.items.push(item);\n  }"
        );
        assert_eq!((view.start_line, view.end_line), (12, 14));
    }

    #[test]
    fn follows_the_declaration_after_the_file_is_edited() {
        // The whole point of re-parsing: a stored line range would now be wrong.
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "a.ts", SAMPLE);
        let before = read(&path, Some("alpha"), None).expect("read");
        assert_eq!(before.start_line, 3);

        write(
            &dir,
            "a.ts",
            &format!("// a new line\n// and another\n{SAMPLE}"),
        );
        let after = read(&path, Some("alpha"), None).expect("read");
        assert_eq!(after.start_line, 5, "declaration moved down two lines");
        assert_eq!(after.text, before.text, "same code, found at its new home");
    }

    #[test]
    fn says_so_when_the_declaration_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "a.ts", SAMPLE);
        let error = read(&path, Some("removed"), None).expect_err("should fail");
        assert!(error.contains("no longer declared"), "{error}");
    }

    #[test]
    fn reads_a_whole_file_when_no_name_is_given() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "a.ts", SAMPLE);
        let view = read(&path, None, None).expect("read");
        assert_eq!(view.text, SAMPLE);
        assert_eq!(view.start_line, 1);
        assert!(!view.truncated);
    }

    #[test]
    fn truncates_a_very_long_file() {
        let dir = tempfile::tempdir().unwrap();
        let long = "const x = 1;\n".repeat(MAX_WHOLE_FILE_LINES + 500);
        let path = write(&dir, "long.ts", &long);
        let view = read(&path, None, None).expect("read");
        assert!(view.truncated);
        assert_eq!(view.end_line, MAX_WHOLE_FILE_LINES);
    }

    #[test]
    fn reports_a_missing_file_rather_than_panicking() {
        let error = read(std::path::Path::new("/nope/missing.ts"), None, None).expect_err("fail");
        assert!(error.contains("cannot read"), "{error}");
    }
}
