import dagre from "dagre";
import { MarkerType, Position, type Edge, type Node } from "@xyflow/react";

import type { Waypoint as Point } from "./RoutedEdge";
import type { ProjectGraph } from "./types";

export const NODE_HEIGHT = 46;

const CHAR_WIDTH = 7.1;
const NODE_PADDING = 30;
const MIN_NODE_WIDTH = 148;
const MAX_NODE_WIDTH = 300;

/**
 * Left-to-right reads better than top-down here: file names are wide and short,
 * so ranks stack vertically and long names never overlap their neighbours.
 */
const RANK_DIRECTION = "LR";

/** Approximate the rendered width of a node so dagre can space ranks honestly. */
function nodeWidth(lines: string[]): number {
  const longest = Math.max(...lines.map((line) => line.length));
  const estimate = longest * CHAR_WIDTH + NODE_PADDING;
  return Math.min(MAX_NODE_WIDTH, Math.max(MIN_NODE_WIDTH, Math.round(estimate)));
}

/**
 * The file's type: the final extension, except that declaration files keep their
 * `d.ts` so they are not mistaken for ordinary sources. Taking everything after
 * the first dot instead would turn `vite.config.ts` into `config.ts`.
 */
function extensionOf(label: string): string {
  if (label.endsWith(".d.ts")) return "d.ts";
  const dot = label.lastIndexOf(".");
  return dot === -1 ? "" : label.slice(dot + 1);
}

/**
 * A stable hue per directory, so sibling files share a colour and the eye can
 * pick out clusters. Kept inside the teal/cyan/blue/indigo arc to stay within
 * the blueprint palette rather than turning the canvas into confetti.
 */
const HUE_START = 150;
const HUE_RANGE = 120;

export function directoryHue(id: string): number {
  const slash = id.lastIndexOf("/");
  const directory = slash === -1 ? "" : id.slice(0, slash);

  let hash = 0;
  for (let i = 0; i < directory.length; i++) {
    hash = (hash * 31 + directory.charCodeAt(i)) >>> 0;
  }
  return HUE_START + (hash % HUE_RANGE);
}

/** The metrics line under the file name, e.g. `tsx · 4 in · 0 out`. */
function detailLine(extension: string, inDegree: number, outDegree: number): string {
  return `${extension} · ${inDegree} in · ${outDegree} out`;
}

/** Turn a scanned project graph into positioned React Flow nodes and edges. */
export function toFlowGraph(graph: ProjectGraph): { nodes: Node[]; edges: Edge[] } {
  // The scanner only emits edges between files it also emitted as nodes, but guard
  // anyway: dagre would otherwise invent a zero-sized node and skew the layout.
  const known = new Set(graph.nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => known.has(edge.source) && known.has(edge.target));

  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const edge of edges) {
    outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }

  const dag = new dagre.graphlib.Graph();
  dag.setDefaultEdgeLabel(() => ({}));
  dag.setGraph({
    rankdir: RANK_DIRECTION,
    nodesep: 22,
    // Rank gaps double as the channels edges change lanes in, and `edgesep`
    // keeps parallel edges from stacking on top of each other there.
    ranksep: 120,
    edgesep: 18,
    marginx: 48,
    marginy: 48,
  });

  const widths = new Map<string, number>();
  for (const node of graph.nodes) {
    const extension = extensionOf(node.label);
    const width = nodeWidth([
      node.label,
      detailLine(extension, inDegree.get(node.id) ?? 0, outDegree.get(node.id) ?? 0),
    ]);
    widths.set(node.id, width);
    dag.setNode(node.id, { width, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    dag.setEdge(edge.source, edge.target);
  }

  dagre.layout(dag);

  const flowNodes: Node[] = graph.nodes.map((node) => {
    const positioned = dag.node(node.id);
    const width = widths.get(node.id) ?? MIN_NODE_WIDTH;
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
      // `width`/`height` alone do not count as measured: `adoptUserNodes` fills
      // `measured` purely from this field, and treats the whole graph as
      // uninitialised while any node lacks it — which silently makes `fitView`
      // and friends do nothing at all.
      measured: { width, height: NODE_HEIGHT },
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
      data: {
        label: node.label,
        path: node.path,
        id: node.id,
        extension: extensionOf(node.label),
        inDegree: inDegree.get(node.id) ?? 0,
        outDegree: outDegree.get(node.id) ?? 0,
        hue: directoryHue(node.id),
      },
      type: "file",
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    };
  });

  const flowEdges: Edge[] = edges.map((edge) => {
    // dagre routes multi-rank edges around the boxes in between and hands back
    // the lanes it reserved. Its first and last points sit on the node borders,
    // which React Flow supplies more precisely from the handles, so keep only
    // the interior ones.
    const routed = dag.edge(edge.source, edge.target) as { points?: Point[] } | undefined;
    const waypoints = (routed?.points ?? []).slice(1, -1);

    return {
      id: `${edge.source}->${edge.target}`,
      source: edge.source,
      target: edge.target,
      // Right-angle routing: schematic rather than organic.
      type: "routed",
      data: { waypoints },
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#2a5a7d" },
      // Stroke lives in CSS so the zoom bands can thicken it as the view pulls back;
      // an inline style here would outrank them. Focus highlighting sets one on
      // purpose, to outrank exactly that.
    };
  });

  return { nodes: flowNodes, edges: flowEdges };
}
