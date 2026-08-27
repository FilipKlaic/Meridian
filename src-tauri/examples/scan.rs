//! Run the scanner against a real project from the terminal:
//!
//!     cargo run --example scan -- /path/to/project
//!     cargo run --example scan -- /path/to/project --json

use std::path::Path;
use std::time::Instant;

fn main() {
    let Some(root) = std::env::args().nth(1) else {
        eprintln!("usage: cargo run --example scan -- <project-path> [--json]");
        std::process::exit(2);
    };
    let as_json = std::env::args().any(|arg| arg == "--json");

    let started = Instant::now();
    match meridian_lib::scanner::scan(Path::new(&root)) {
        Ok(graph) if as_json => {
            println!(
                "{}",
                serde_json::to_string_pretty(&graph).expect("serialize")
            );
        }
        Ok(graph) => {
            println!(
                "{} files, {} imports in {:?}",
                graph.nodes.len(),
                graph.edges.len(),
                started.elapsed()
            );
            for edge in &graph.edges {
                println!("  {} -> {}", edge.source, edge.target);
            }
        }
        Err(err) => {
            eprintln!("error: {err}");
            std::process::exit(1);
        }
    }
}
