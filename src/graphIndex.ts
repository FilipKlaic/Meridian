import type { ProjectGraph, SymbolKind } from "./types";

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

/** One declaration, with the calls either side of it already gathered. */
export type SymbolEntry = {
  /** `src/auth.ts#requireUser`, unique across the project. */
  id: string;
  /** Id of the file that declares it. */
  file: string;
  /** Bare declaration name, which is what the source reader looks for. */
  name: string;
  /** `requireUser`, or `Auth.login` for a method. */
  label: string;
  kind: SymbolKind;
  container: string | null;
  exported: boolean;
  line: number;
  /** Ids of symbols this one calls. */
  calls: string[];
  /** Ids of symbols that call this one. */
  calledBy: string[];
};

export type GraphIndex = {
  byId: Map<string, FileEntry>;
  /** Every file, ordered by path. */
  entries: FileEntry[];
  /** The same files grouped under their directory, both in path order. */
  directories: { name: string; files: FileEntry[] }[];
  symbolsById: Map<string, SymbolEntry>;
  /** Every symbol, ordered by id. Empty for a scan taken before symbols existed. */
  symbols: SymbolEntry[];
  /** A file's declarations, in the order they appear in the source. */
  symbolsByFile: Map<string, SymbolEntry[]>;
};

export const EMPTY_INDEX: GraphIndex = {
  byId: new Map(),
  entries: [],
  directories: [],
  symbolsById: new Map(),
  symbols: [],
  symbolsByFile: new Map(),
};

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

  const symbolsById = new Map<string, SymbolEntry>();
  for (const symbol of graph.symbols ?? []) {
    symbolsById.set(symbol.id, {
      id: symbol.id,
      file: symbol.file,
      name: symbol.name,
      label: symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name,
      kind: symbol.kind,
      container: symbol.container,
      exported: symbol.exported,
      line: symbol.line,
      calls: [],
      calledBy: [],
    });
  }

  // Both directions, once, for the same reason the file adjacency is built here:
  // the panels ask "what does this one touch" on every selection, and scanning
  // the whole call list to answer that does not scale past a few thousand.
  for (const call of graph.calls ?? []) {
    symbolsById.get(call.source)?.calls.push(call.target);
    symbolsById.get(call.target)?.calledBy.push(call.source);
  }

  const symbols = [...symbolsById.values()].sort((a, b) => a.id.localeCompare(b.id));

  const symbolsByFile = new Map<string, SymbolEntry[]>();
  // Source order, not the id order above: a file reads top to bottom.
  for (const symbol of [...symbolsById.values()].sort((a, b) => a.line - b.line)) {
    const bucket = symbolsByFile.get(symbol.file);
    if (bucket) bucket.push(symbol);
    else symbolsByFile.set(symbol.file, [symbol]);
  }

  return { byId, entries, directories, symbolsById, symbols, symbolsByFile };
}
