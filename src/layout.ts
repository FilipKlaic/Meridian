import dagre from "dagre";
import { MarkerType, Position, type Edge, type Node } from "@xyflow/react";

import type { ProjectGraph } from "./types";

export const NODE_HEIGHT = 36;

const CHAR_WIDTH = 7.2;
const NODE_PADDING = 28;
const MIN_NODE_WIDTH = 120;
const MAX_NODE_WIDTH = 280;

/**
 * Left-to-right reads better than top-down here: file names are wide and short,
 * so ranks stack vertically and long names never overlap their neighbours.
 */
const RANK_DIRECTION = "LR";

/** Approximate the rendered width of a node so dagre can space ranks honestly. */
function nodeWidth(label: string): number {
  const estimate = label.length * CHAR_WIDTH + NODE_PADDING;
  return Math.min(MAX_NODE_WIDTH, Math.max(MIN_NODE_WIDTH, Math.round(estimate)));
}

/** Turn a scanned project graph into positioned React Flow nodes and edges. */
export function toFlowGraph(graph: ProjectGraph): { nodes: Node[]; edges: Edge[] } {
  const dag = new dagre.graphlib.Graph();
  dag.setDefaultEdgeLabel(() => ({}));
  dag.setGraph({ rankdir: RANK_DIRECTION, nodesep: 18, ranksep: 90, marginx: 40, marginy: 40 });

  for (const node of graph.nodes) {
    dag.setNode(node.id, { width: nodeWidth(node.label), height: NODE_HEIGHT });
  }
  // The scanner only emits edges between files it also emitted as nodes, but guard
  // anyway: dagre would otherwise invent a zero-sized node and skew the layout.
  const known = new Set(graph.nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => known.has(edge.source) && known.has(edge.target));
  for (const edge of edges) {
    dag.setEdge(edge.source, edge.target);
  }

  dagre.layout(dag);

  const flowNodes: Node[] = graph.nodes.map((node) => {
    const positioned = dag.node(node.id);
    const width = nodeWidth(node.label);
    return {
      id: node.id,
      // dagre positions nodes by their centre, React Flow by their top-left corner.
      position: {
        x: positioned.x - width / 2,
        y: positioned.y - NODE_HEIGHT / 2,
      },
      // Declare the geometry dagre laid out instead of waiting for React Flow to
      // measure the DOM: until measurements land it treats a node as uninitialised,
      // keeping it hidden and refusing to draw any edge attached to it.
      //
      // Note that declaring `handles` opts out of DOM handle measurement for good
      // (see `parseHandles` in @xyflow/system), so these positions must stay in step
      // with what `FileNode` renders: a box of exactly this size, with the target
      // handle centred on its left edge and the source handle on its right.
      width,
      height: NODE_HEIGHT,
      handles: [
        {
          id: null,
          type: "target",
          position: Position.Left,
          x: 0,
          y: NODE_HEIGHT / 2,
          width: 0,
          height: 0,
        },
        {
          id: null,
          type: "source",
          position: Position.Right,
          x: width,
          y: NODE_HEIGHT / 2,
          width: 0,
          height: 0,
        },
      ],
      data: { label: node.label, path: node.path, id: node.id },
      type: "file",
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    };
  });

  const flowEdges: Edge[] = edges.map((edge) => ({
    id: `${edge.source}->${edge.target}`,
    source: edge.source,
    target: edge.target,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "#64748b" },
    style: { stroke: "#64748b", strokeWidth: 1.5 },
  }));

  return { nodes: flowNodes, edges: flowEdges };
}
