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
 * pick out clusters. Kept inside the rust/ochre/olive/moss arc: earth tones
 * that sit on warm paper rather than turning the canvas into confetti.
 */
const HUE_START = 12;
const HUE_RANGE = 114;

/** Mid-arc, for the rare node that reaches a renderer without a hue. */
export const DEFAULT_HUE = HUE_START + HUE_RANGE / 2;

export function directoryHue(id: string): number {
  const slash = id.lastIndexOf("/");
  const directory = slash === -1 ? "" : id.slice(0, slash);

  let hash = 0;
  for (let i = 0; i < directory.length; i++) {
    hash = (hash * 31 + directory.charCodeAt(i)) >>> 0;
  }
  return HUE_START + (hash % HUE_RANGE);
}

/**
 * A directory hue as a paintable colour. Saturation and lightness live here
 * rather than at each call site so a node, its inspector dot and its minimap
 * blip are guaranteed to be the same ink.
 */
export function hueInk(hue: number): string {
  // 36% lightness, not 40%: yellow-greens are intrinsically lighter at the same
  // HSL lightness, and 40% put the middle of the arc under 3:1 against paper.
  return `hsl(${hue} 52% 36%)`;
}

export function directoryColor(id: string): string {
  return hueInk(directoryHue(id));
}

/** The metrics line under the file name, e.g. `tsx · 4 in · 0 out`. */
function detailLine(extension: string, inDegree: number, outDegree: number): string {
  return `${extension} · ${inDegree} in · ${outDegree} out`;
}

/** A box handed to dagre for placement. */
export type LayoutBox = { id: string; width: number; height: number };

export type DagreLayout = {
  /** Centre position dagre chose for a box. */
  centre: (id: string) => { x: number; y: number };
  /** Interior waypoints of the lane dagre reserved for a link. */
  waypoints: (source: string, target: string) => Point[];
};

/**
 * Run dagre over a set of boxes and links. Shared by the file graph and the call
 * graph so both lay out and route identically.
 */
export function runDagre(
  boxes: LayoutBox[],
  links: { source: string; target: string }[],
): DagreLayout {
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

  for (const box of boxes) dag.setNode(box.id, { width: box.width, height: box.height });
  for (const link of links) dag.setEdge(link.source, link.target);

  dagre.layout(dag);

  return {
    centre: (id) => dag.node(id),
    waypoints: (source, target) => {
      const routed = dag.edge(source, target) as { points?: Point[] } | undefined;
      // dagre routes multi-rank links around the boxes in between and hands back
      // the lanes it reserved. Its first and last points sit on the node borders,
      // which React Flow supplies more precisely from the handles, so keep only
      // the interior ones.
      return (routed?.points ?? []).slice(1, -1);
    },
  };
}

/**
 * Position and size one node the way React Flow needs it, given the centre dagre
 * chose. Declaring the geometry rather than waiting for React Flow to measure the
 * DOM matters: until measurements land it treats a node as uninitialised, keeps it
 * hidden, and refuses to draw any edge attached to it. `measured` has to be set
 * too — `adoptUserNodes` fills that field only from itself, and a graph where any
 * node lacks it makes fitView and friends silently do nothing.
 *
 * Note that declaring `handles` opts out of DOM handle measurement for good (see
 * `parseHandles` in @xyflow/system), so these stay in step with what the node
 * components render: a box of exactly this size, target handle centred on its
 * left edge, source handle on its right.
 */
export function placeNode(
  id: string,
  centre: { x: number; y: number },
  width: number,
  type: string,
  data: Record<string, unknown>,
): Node {
  return {
    id,
    // dagre positions nodes by their centre, React Flow by their top-left corner.
    position: { x: centre.x - width / 2, y: centre.y - NODE_HEIGHT / 2 },
    width,
    height: NODE_HEIGHT,
    measured: { width, height: NODE_HEIGHT },
    handles: [
      { id: null, type: "target", position: Position.Left, x: 0, y: NODE_HEIGHT / 2, width: 0, height: 0 },
      { id: null, type: "source", position: Position.Right, x: width, y: NODE_HEIGHT / 2, width: 0, height: 0 },
    ],
    data,
    type,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
  };
}

/** Build a routed edge that follows the lane dagre reserved for it. */
export function routedEdge(
  source: string,
  target: string,
  layout: DagreLayout,
  extra: Partial<Edge> = {},
): Edge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    // Right-angle routing: schematic rather than organic.
    type: "routed",
    data: { waypoints: layout.waypoints(source, target) },
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#8a7a60" },
    // Stroke lives in CSS so the zoom bands can thicken it as the view pulls back;
    // an inline style here would outrank them. Focus highlighting sets one on
    // purpose, to outrank exactly that.
    ...extra,
  };
}

/** Estimate a node's width from the widest line it will render. */
export function boxWidth(lines: string[]): number {
  return nodeWidth(lines);
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

  const widths = new Map<string, number>();
  const boxes: LayoutBox[] = graph.nodes.map((node) => {
    const width = boxWidth([
      node.label,
      detailLine(extensionOf(node.label), inDegree.get(node.id) ?? 0, outDegree.get(node.id) ?? 0),
    ]);
    widths.set(node.id, width);
    return { id: node.id, width, height: NODE_HEIGHT };
  });

  const layout = runDagre(boxes, edges);

  const flowNodes = graph.nodes.map((node) =>
    placeNode(node.id, layout.centre(node.id), widths.get(node.id) ?? MIN_NODE_WIDTH, "file", {
      label: node.label,
      path: node.path,
      id: node.id,
      extension: extensionOf(node.label),
      inDegree: inDegree.get(node.id) ?? 0,
      outDegree: outDegree.get(node.id) ?? 0,
      hue: directoryHue(node.id),
    }),
  );

  const flowEdges = edges.map((edge) => routedEdge(edge.source, edge.target, layout));

  return { nodes: flowNodes, edges: flowEdges };
}
