//! Reading `baseUrl` and `paths` out of `tsconfig.json`, so that a non-relative
//! specifier like `@/components/Button` can still point at a file in the project.
//!
//! This is deliberately only the module-resolution slice of a tsconfig. Everything
//! else in the file is ignored.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

/// How the imports written in one directory are rewritten. A config applies to
/// every file beneath the directory it was found in.
#[derive(Debug, Clone)]
pub struct Config {
    pub dir: PathBuf,
    base_url: Option<PathBuf>,
    patterns: Vec<Pattern>,
}

/// One entry of `compilerOptions.paths`, e.g. `"@/*": ["./src/*"]`.
#[derive(Debug, Clone)]
struct Pattern {
    /// Text before the `*`, or the whole key when there is no `*`.
    prefix: String,
    /// Text after the `*`.
    suffix: String,
    wildcard: bool,
    /// Substitution templates, each still holding its own `*`.
    targets: Vec<String>,
    /// Directory the templates are relative to.
    base: PathBuf,
}

/// Read every config the walk found. Deepest directory first, so the first config
/// whose directory contains a file is that file's nearest one.
pub fn load_all(files: &[PathBuf]) -> Vec<Config> {
    let mut configs: Vec<Config> = files.iter().filter_map(|file| load(file)).collect();
    configs.sort_by_key(|config| std::cmp::Reverse(config.dir.components().count()));
    configs
}

fn load(file: &Path) -> Option<Config> {
    let dir = file.parent()?.to_path_buf();
    let settings = read(file, &mut HashSet::new(), 0)?;
    if settings.base_url.is_none() && settings.patterns.is_empty() {
        // Nothing here that could rewrite a specifier.
        return None;
    }
    Some(Config {
        dir,
        base_url: settings.base_url,
        patterns: settings.patterns,
    })
}

impl Config {
    /// The paths a specifier could name, best candidate first. Extensions are not
    /// applied here: the caller probes each candidate the same way it probes a
    /// relative import.
    pub fn candidates(&self, specifier: &str) -> Vec<PathBuf> {
        let mut out = Vec::new();

        if let Some(pattern) = self.best_match(specifier) {
            let matched = &specifier[pattern.prefix.len()..specifier.len() - pattern.suffix.len()];
            for target in &pattern.targets {
                out.push(pattern.base.join(target.replacen('*', matched, 1)));
            }
        }

        // `baseUrl` is tried after `paths`, mirroring TypeScript's own order.
        if let Some(base) = &self.base_url {
            out.push(base.join(specifier));
        }

        out
    }

    /// An exact key beats a wildcard one; between wildcards the longest matching
    /// prefix wins, which is how TypeScript breaks the tie.
    fn best_match(&self, specifier: &str) -> Option<&Pattern> {
        let mut best: Option<&Pattern> = None;
        for pattern in &self.patterns {
            if !pattern.matches(specifier) {
                continue;
            }
            if !pattern.wildcard {
                return Some(pattern);
            }
            let better = match best {
                None => true,
                Some(current) => pattern.prefix.len() > current.prefix.len(),
            };
            if better {
                best = Some(pattern);
            }
        }
        best
    }
}

impl Pattern {
    fn matches(&self, specifier: &str) -> bool {
        if !self.wildcard {
            return specifier == self.prefix;
        }
        specifier.len() >= self.prefix.len() + self.suffix.len()
            && specifier.starts_with(&self.prefix)
            && specifier.ends_with(&self.suffix)
    }
}

/// What one config file contributes, once its `extends` chain has been folded in.
#[derive(Debug, Default)]
struct Settings {
    base_url: Option<PathBuf>,
    patterns: Vec<Pattern>,
}

impl Settings {
    /// Merge a config this one inherits from. Anything the inherited config states
    /// replaces what we had, since it is read before our own fields.
    fn absorb(&mut self, other: Settings) {
        if other.base_url.is_some() {
            self.base_url = other.base_url;
        }
        if !other.patterns.is_empty() {
            self.patterns = other.patterns;
        }
    }
}

/// Depth limit for `extends`/`references` chains. `seen` already stops cycles;
/// this stops a pathological but acyclic chain from costing anything noticeable.
const MAX_DEPTH: usize = 8;

fn read(file: &Path, seen: &mut HashSet<PathBuf>, depth: usize) -> Option<Settings> {
    if depth > MAX_DEPTH || !seen.insert(file.to_path_buf()) {
        return None;
    }
    let dir = file.parent()?;
    let text = std::fs::read_to_string(file).ok()?;
    let value: Value = serde_json::from_str(&strip_jsonc(&text)).ok()?;

    let mut settings = Settings::default();

    for parent in chain(&value, "extends", dir) {
        if let Some(inherited) = read(&parent, seen, depth + 1) {
            settings.absorb(inherited);
        }
    }

    let options = value.get("compilerOptions");
    if let Some(base) = options
        .and_then(|options| options.get("baseUrl"))
        .and_then(Value::as_str)
    {
        settings.base_url = Some(dir.join(base));
    }
    if let Some(paths) = options
        .and_then(|options| options.get("paths"))
        .and_then(Value::as_object)
    {
        // `paths` hang off `baseUrl` when there is one, and off this file's own
        // directory otherwise.
        let base = settings
            .base_url
            .clone()
            .unwrap_or_else(|| dir.to_path_buf());
        settings.patterns = patterns(paths, &base);
    }

    // A root config that only lists `references` keeps its aliases in the projects
    // it points at — the shape Vite's template generates. Those are a fallback for
    // anything this file did not define itself.
    for reference in chain(&value, "references", dir) {
        if let Some(referenced) = read(&reference, seen, depth + 1) {
            if settings.base_url.is_none() {
                settings.base_url = referenced.base_url;
            }
            settings.patterns.extend(referenced.patterns);
        }
    }

    Some(settings)
}

fn patterns(paths: &Map<String, Value>, base: &Path) -> Vec<Pattern> {
    paths
        .iter()
        .filter_map(|(key, value)| {
            let targets: Vec<String> = value
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            if targets.is_empty() {
                return None;
            }
            let (prefix, suffix, wildcard) = match key.split_once('*') {
                Some((prefix, suffix)) => (prefix.to_owned(), suffix.to_owned(), true),
                None => (key.clone(), String::new(), false),
            };
            Some(Pattern {
                prefix,
                suffix,
                wildcard,
                targets,
                base: base.to_path_buf(),
            })
        })
        .collect()
}

/// The config files named by `extends` (a string or an array) or `references`
/// (objects with a `path`). Only relative and absolute specifiers are followed;
/// a bare one names a package under `node_modules`, which a scan never walks.
fn chain(value: &Value, field: &str, dir: &Path) -> Vec<PathBuf> {
    let specifiers: Vec<&str> = match value.get(field) {
        Some(Value::String(one)) => vec![one.as_str()],
        Some(Value::Array(many)) => many
            .iter()
            .filter_map(|entry| match entry {
                Value::String(text) => Some(text.as_str()),
                // `references` entries are `{ "path": "./tsconfig.app.json" }`.
                Value::Object(_) => entry.get("path").and_then(Value::as_str),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };

    specifiers
        .into_iter()
        .filter_map(|specifier| {
            let path = Path::new(specifier);
            let base = if path.is_absolute() {
                path.to_path_buf()
            } else if specifier.starts_with("./") || specifier.starts_with("../") {
                dir.join(specifier)
            } else {
                return None;
            };
            // A `references` path, and an `extends` without `.json`, may name a
            // directory holding a `tsconfig.json`.
            if base.is_dir() {
                return Some(base.join("tsconfig.json"));
            }
            if base.extension().is_some_and(|ext| ext == "json") {
                return Some(base);
            }
            let mut name = base.file_name()?.to_os_string();
            name.push(".json");
            Some(base.with_file_name(name))
        })
        .collect()
}

/// `tsconfig.json` is JSON with comments and trailing commas, which `serde_json`
/// rejects. Strip both, leaving string literals untouched.
fn strip_jsonc(src: &str) -> String {
    let chars: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len());
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];

        if c == '"' {
            out.push(c);
            i += 1;
            while i < chars.len() {
                let c = chars[i];
                out.push(c);
                i += 1;
                if c == '\\' {
                    if let Some(escaped) = chars.get(i) {
                        out.push(*escaped);
                        i += 1;
                    }
                } else if c == '"' {
                    break;
                }
            }
            continue;
        }

        if c == '/' {
            match chars.get(i + 1) {
                Some('/') => {
                    while i < chars.len() && chars[i] != '\n' {
                        i += 1;
                    }
                    continue;
                }
                Some('*') => {
                    i += 2;
                    while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                        i += 1;
                    }
                    i = (i + 2).min(chars.len());
                    continue;
                }
                _ => {}
            }
        }

        if c == '}' || c == ']' {
            let trailing = {
                let trimmed = out.trim_end();
                trimmed.ends_with(',').then(|| trimmed.len() - 1)
            };
            if let Some(cut) = trailing {
                out.truncate(cut);
            }
        }

        out.push(c);
        i += 1;
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_comments_and_trailing_commas() {
        let src = r#"{
            // line comment
            "compilerOptions": {
                /* block
                   comment */
                "baseUrl": ".",
                "paths": { "@/*": ["src/*"], },
            },
        }"#;
        let value: Value = serde_json::from_str(&strip_jsonc(src)).expect("parse");
        assert_eq!(value["compilerOptions"]["baseUrl"], ".");
        assert_eq!(value["compilerOptions"]["paths"]["@/*"][0], "src/*");
    }

    #[test]
    fn leaves_comment_markers_inside_strings_alone() {
        let src = r#"{ "a": "http://x/y", "b": "/* not a comment */", "c": "quote\" // no" }"#;
        let value: Value = serde_json::from_str(&strip_jsonc(src)).expect("parse");
        assert_eq!(value["a"], "http://x/y");
        assert_eq!(value["b"], "/* not a comment */");
        assert_eq!(value["c"], "quote\" // no");
    }

    fn config(patterns: Vec<(&str, Vec<&str>)>) -> Config {
        let mut map = Map::new();
        for (key, targets) in patterns {
            map.insert(
                key.to_string(),
                Value::Array(targets.into_iter().map(|t| Value::String(t.into())).collect()),
            );
        }
        Config {
            dir: PathBuf::from("/p"),
            base_url: None,
            patterns: super::patterns(&map, Path::new("/p")),
        }
    }

    #[test]
    fn prefers_an_exact_key_over_a_wildcard_one() {
        let config = config(vec![
            ("@/*", vec!["src/*"]),
            ("@/special", vec!["vendor/special.ts"]),
        ]);
        assert_eq!(
            config.candidates("@/special"),
            vec![PathBuf::from("/p/vendor/special.ts")]
        );
        assert_eq!(
            config.candidates("@/other"),
            vec![PathBuf::from("/p/src/other")]
        );
    }

    #[test]
    fn prefers_the_longest_matching_prefix() {
        let config = config(vec![
            ("@/*", vec!["src/*"]),
            ("@/ui/*", vec!["packages/ui/*"]),
        ]);
        assert_eq!(
            config.candidates("@/ui/Button"),
            vec![PathBuf::from("/p/packages/ui/Button")]
        );
    }

    #[test]
    fn offers_every_target_in_order_and_matches_a_suffix() {
        let config = config(vec![("~*.css", vec!["styles/*.css", "vendor/*.css"])]);
        assert_eq!(
            config.candidates("~main.css"),
            vec![
                PathBuf::from("/p/styles/main.css"),
                PathBuf::from("/p/vendor/main.css"),
            ]
        );
        assert!(config.candidates("~main.scss").is_empty());
    }
}
