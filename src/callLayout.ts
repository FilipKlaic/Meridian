import type { Edge, Node } from "@xyflow/react";

import { NODE_HEIGHT, boxWidth, directoryHue, placeNode, routedEdge, runDagre } from "./layout";
import type { LayoutBox } from "./layout";
import type { Call, Symbol } from "./types";

/**
 * What the call graph is built around: every function in one file, or a single
 * function on its own.
 *
 * A file answers "what goes on in here". A symbol answers "what does this one
 * function touch, and how far does it reach" — the finer question, and the
 * reason both exist. A file with forty declarations buries the connections of
 * the one function you actually came to look at.
 */
export type CallAnchor = { kind: "file" | "symbol"; id: string };

/** A call graph narrowed to one anchor and whatever it directly touches. */
export type CallView = {
  nodes: Node[];
  edges: Edge[];
  /** Symbols the anchor stands for: a file's declarations, or the one symbol. */
  ownCount: number;
  /** Symbols pulled in from elsewhere, one hop away. */
  neighbourCount: number;
  /** Symbols outside the anchor that call into it. */
  callerCount: number;
  /** Symbols outside the anchor that it calls out to. */
  calleeCount: number;
  /** Calls shown that were matched by name only. */
  guessCount: number;
};

export const EMPTY_CALL_VIEW: CallView = {
  nodes: [],
  edges: [],
  ownCount: 0,
  neighbourCount: 0,
  callerCount: 0,
  calleeCount: 0,
  guessCount: 0,
};

/** `requireUser`, or `Auth.login` for a method — so two `render`s stay apart. */
function labelFor(symbol: Symbol): string {
  return symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name;
}

function detailFor(symbol: Symbol, anchorFile: string): string {
  if (symbol.file !== anchorFile) return symbol.file;
  return symbol.container ? `${symbol.kind} · ${symbol.container}` : symbol.kind;
}

/**
 * Build the call graph around one anchor: everything it covers, plus each symbol
 * one hop away in either direction.
 *
 * One hop, and no further, is a deliberate limit rather than a shortcut. Calls
 * are resolved by name without a type checker, so a `guess` edge is the tool's
 * inference; chains of them compound into something it cannot stand behind.
 * Stepping outward is done by re-anchoring on a neighbour — one hop the user has
 * seen and accepted at a time — instead of widening the radius here.
 */
export function toCallView(
  symbols: Symbol[],
  calls: Call[],
  anchor: CallAnchor | null,
): CallView {
  if (!anchor) return EMPTY_CALL_VIEW;

  const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));

  const own = new Set(
    anchor.kind === "file"
      ? symbols.filter((symbol) => symbol.file === anchor.id).map((symbol) => symbol.id)
      : byId.has(anchor.id)
        ? [anchor.id]
        : [],
  );
  if (own.size === 0) return EMPTY_CALL_VIEW;

  // The file a neighbour is measured against, so "elsewhere" means the same
  // thing whichever kind of anchor we are drawing.
  const anchorFile = anchor.kind === "file" ? anchor.id : byId.get(anchor.id)!.file;

  // Keep calls with at least one end inside the anchor.
  const relevant = calls.filter(
    (call) => (own.has(call.source) || own.has(call.target)) && byId.has(call.source) && byId.has(call.target),
  );

  const visible = new Set(own);
  // Calls that stay inside the anchor are its internals, not its connections, so
  // they count towards neither direction.
  const callers = new Set<string>();
  const callees = new Set<string>();
  for (const call of relevant) {
    visible.add(call.source);
    visible.add(call.target);
    if (own.has(call.target) && !own.has(call.source)) callers.add(call.source);
    if (own.has(call.source) && !own.has(call.target)) callees.add(call.target);
  }

  // A symbol the anchor covers but nothing calls still belongs on the canvas —
  // an uncalled export is exactly the kind of thing worth noticing.
  const shown = [...visible].map((id) => byId.get(id)!).sort((a, b) => a.id.localeCompare(b.id));

  const widths = new Map<string, number>();
  const boxes: LayoutBox[] = shown.map((symbol) => {
    const width = boxWidth([labelFor(symbol), detailFor(symbol, anchorFile)]);
    widths.set(symbol.id, width);
    return { id: symbol.id, width, height: NODE_HEIGHT };
  });

  const layout = runDagre(boxes, relevant);

  const nodes = shown.map((symbol) => {
    const node = placeNode(symbol.id, layout.centre(symbol.id), widths.get(symbol.id)!, "symbol", {
      label: labelFor(symbol),
      id: symbol.id,
      detail: detailFor(symbol, anchorFile),
      kind: symbol.kind,
      file: symbol.file,
      name: symbol.name,
      container: symbol.container,
      exported: symbol.exported,
      external: symbol.file !== anchorFile,
      hue: directoryHue(symbol.file),
    });
    // Only a symbol anchor is a node on screen; a file anchor is the canvas
    // itself, and marking one of its declarations would be a lie.
    return anchor.kind === "symbol" && symbol.id === anchor.id ? { ...node, selected: true } : node;
  });

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
    callerCount: callers.size,
    calleeCount: callees.size,
    guessCount: relevant.filter((call) => call.confidence === "guess").length,
  };
}
