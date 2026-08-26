/** Mirrors the `ProjectGraph` returned by the `scan_project` Rust command. */
export type ProjectGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
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
