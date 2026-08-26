//! Run the scanner against a real project from the terminal:
//!
//!     cargo run --example scan -- /path/to/project

use std::path::Path;
use std::time::Instant;

fn main() {
    let Some(root) = std::env::args().nth(1) else {
        eprintln!("usage: cargo run --example scan -- <project-path>");
        std::process::exit(2);
    };

    let started = Instant::now();
    match meridian_lib::scanner::scan(Path::new(&root)) {
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
