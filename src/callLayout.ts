import type { Edge, Node } from "@xyflow/react";

import { NODE_HEIGHT, boxWidth, directoryHue, placeNode, routedEdge, runDagre } from "./layout";
import type { LayoutBox } from "./layout";
import type { Call, Symbol } from "./types";

/** A call graph narrowed to one file and whatever it directly touches. */
export type CallView = {
  nodes: Node[];
  edges: Edge[];
  /** Symbols declared in the focused file. */
  ownCount: number;
  /** Symbols pulled in from other files, one hop away. */
  neighbourCount: number;
  /** Calls shown that were matched by name only. */
  guessCount: number;
};

export const EMPTY_CALL_VIEW: CallView = {
  nodes: [],
  edges: [],
  ownCount: 0,
  neighbourCount: 0,
  guessCount: 0,
};

function detailFor(symbol: Symbol, focusFile: string): string {
  if (symbol.file !== focusFile) return symbol.file;
  return symbol.container ? `${symbol.kind} · ${symbol.container}` : symbol.kind;
}

/**
 * Build the call graph around one file: everything it declares, plus each symbol
 * one hop away in either direction.
 *
 * A whole-project call graph is thousands of nodes and reads as noise, so the
 * view is always anchored to a file; stepping outward is done by focusing a
 * neighbour instead of widening the radius.
 */
export function toCallView(
  symbols: Symbol[],
  calls: Call[],
  focusFile: string | null,
): CallView {
  if (!focusFile) return EMPTY_CALL_VIEW;

  const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const own = new Set(
    symbols.filter((symbol) => symbol.file === focusFile).map((symbol) => symbol.id),
  );
  if (own.size === 0) return EMPTY_CALL_VIEW;

  // Keep calls with at least one end inside the focused file.
  const relevant = calls.filter(
    (call) => (own.has(call.source) || own.has(call.target)) && byId.has(call.source) && byId.has(call.target),
  );

  const visible = new Set(own);
  for (const call of relevant) {
    visible.add(call.source);
    visible.add(call.target);
  }

  // A symbol the file declares but nothing calls still belongs on the canvas —
  // an uncalled export is exactly the kind of thing worth noticing.
  const shown = [...visible].map((id) => byId.get(id)!).sort((a, b) => a.id.localeCompare(b.id));

  const widths = new Map<string, number>();
  const boxes: LayoutBox[] = shown.map((symbol) => {
    const width = boxWidth([symbol.name, detailFor(symbol, focusFile)]);
    widths.set(symbol.id, width);
    return { id: symbol.id, width, height: NODE_HEIGHT };
  });

  const layout = runDagre(boxes, relevant);

  const nodes = shown.map((symbol) =>
    placeNode(symbol.id, layout.centre(symbol.id), widths.get(symbol.id)!, "symbol", {
      label: symbol.name,
      id: symbol.id,
      detail: detailFor(symbol, focusFile),
      kind: symbol.kind,
      file: symbol.file,
      name: symbol.name,
      container: symbol.container,
      exported: symbol.exported,
      external: symbol.file !== focusFile,
      hue: directoryHue(symbol.file),
    }),
  );

  const edges = relevant.map((call) =>
    routedEdge(call.source, call.target, layout, {
      // Name-matched calls are drawn dashed: they are the tool's guess, not a fact.
      className: call.confidence === "guess" ? "is-guess" : undefined,
    }),
  );

  return {
    nodes,
    edges,
    ownCount: own.size,
    neighbourCount: visible.size - own.size,
    guessCount: relevant.filter((call) => call.confidence === "guess").length,
  };
}
