/** Mirrors the `ProjectGraph` returned by the `scan_project` Rust command. */
export type ProjectGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Absent on scans cached before function analysis existed. */
  symbols?: Symbol[];
  calls?: Call[];
};

export type SymbolKind = "function" | "method" | "class";

export type Symbol = {
  /** `src/auth.ts#requireUser`, unique across the project. */
  id: string;
  /** Id of the file node this belongs to. */
  file: string;
  name: string;
  kind: SymbolKind;
  /** The class a method belongs to, if any. */
  container: string | null;
  exported: boolean;
  line: number;
};

/**
 * "resolved" means bound through a local declaration or a resolved import.
 * "guess" means matched only by method name, because the receiver's type is
 * unknowable without a type checker.
 */
export type Confidence = "resolved" | "guess";

export type Call = {
  source: string;
  target: string;
  confidence: Confidence;
};

export type GraphNode = {
  /** Project-relative path; the stable identity of a file. */
  id: string;
  /** Absolute path on disk. */
  path: string;
  /** File name, shown on the node. */
  label: string;
};

export type GraphEdge = {
  source: string;
  target: string;
};
