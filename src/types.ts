/** Mirrors the `ProjectGraph` returned by the `scan_project` Rust command. */
export type ProjectGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Absent on scans cached before function analysis existed. */
  symbols?: Symbol[];
  calls?: Call[];
  /** Absent on scans cached before staleness checking existed. */
  fingerprint?: FileStamp[];
};

/** The state of one file at scan time, enough to notice it changed later. */
export type FileStamp = {
  id: string;
  /** Milliseconds since the Unix epoch. */
  modified: number;
  size: number;
};

/** What has changed on disk since a cached scan was taken. */
export type Freshness = {
  added: number;
  removed: number;
  modified: number;
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
