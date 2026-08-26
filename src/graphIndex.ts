import type { ProjectGraph } from "./types";

export type FileEntry = {
  id: string;
  label: string;
  path: string;
  /** Project-relative directory, "" for files at the project root. */
  directory: string;
  /** Files this one imports. */
  imports: string[];
  /** Files that import this one. */
  importedBy: string[];
};

export type GraphIndex = {
  byId: Map<string, FileEntry>;
  /** Every file, ordered by path. */
  entries: FileEntry[];
  /** The same files grouped under their directory, both in path order. */
  directories: { name: string; files: FileEntry[] }[];
};

export const EMPTY_INDEX: GraphIndex = { byId: new Map(), entries: [], directories: [] };

function directoryOf(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash === -1 ? "" : id.slice(0, slash);
}

/**
 * Adjacency and grouping for the panels. The graph itself is an edge list, which
 * answers "what links to what" but not "what does this one file touch", so build
 * both directions once per scan rather than scanning edges on every selection.
 */
export function buildIndex(graph: ProjectGraph | null): GraphIndex {
  if (!graph) return EMPTY_INDEX;

  const byId = new Map<string, FileEntry>();
  for (const node of graph.nodes) {
    byId.set(node.id, {
      id: node.id,
      label: node.label,
      path: node.path,
      directory: directoryOf(node.id),
      imports: [],
      importedBy: [],
    });
  }

  for (const edge of graph.edges) {
    byId.get(edge.source)?.imports.push(edge.target);
    byId.get(edge.target)?.importedBy.push(edge.source);
  }

  const entries = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const entry of entries) {
    entry.imports.sort();
    entry.importedBy.sort();
  }

  const grouped = new Map<string, FileEntry[]>();
  for (const entry of entries) {
    const bucket = grouped.get(entry.directory);
    if (bucket) bucket.push(entry);
    else grouped.set(entry.directory, [entry]);
  }

  const directories = [...grouped.entries()]
    .map(([name, files]) => ({ name, files }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { byId, entries, directories };
}
