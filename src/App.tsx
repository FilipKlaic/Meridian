import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  getNodesBounds,
  getViewportForBounds,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeMarker,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { CanvasHud, LevelOfDetail } from "./CanvasHud";
import CommandPalette, { type PaletteAction } from "./CommandPalette";
import FileNode from "./FileNode";
import Inspector from "./Inspector";
import RoutedEdge from "./RoutedEdge";
import SourceDrawer, { type SourceTarget } from "./SourceDrawer";
import SymbolNode from "./SymbolNode";
import { EMPTY_CALL_VIEW, toCallView, type CallAnchor } from "./callLayout";
import { loadCachedScan, loadLastProject, saveLastProject, saveScan } from "./db";
import { buildIndex } from "./graphIndex";
import { DEFAULT_HUE, hueInk, toFlowGraph } from "./layout";
import type { FileStamp, Freshness, ProjectGraph } from "./types";

const nodeTypes = { file: FileNode, symbol: SymbolNode };
const edgeTypes = { routed: RoutedEdge };

type Tab = "imports" | "calls";

/** `--color-bp-accent`, for the few places a colour has to reach SVG. */
const ACCENT = "#9d3f1a";

const MIN_ZOOM = 0.05;
/** Never zoom past 1:1 when framing, however small the project is. */
const MAX_FIT_ZOOM = 1;

/** Short, human-readable age of a cached scan. */
function describeAge(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Spelled-out breakdown behind a change count, for the tooltip. */
function describeChanges({ added, removed, modified }: Freshness): string {
  const parts: string[] = [];
  if (modified) parts.push(`${modified} edited`);
  if (added) parts.push(`${added} added`);
  if (removed) parts.push(`${removed} removed`);
  return parts.length > 0 ? `${parts.join(", ")} since this scan` : "nothing has changed";
}

function Readout({
  label,
  value,
  warn,
  title,
}: {
  label: string;
  value: string | number;
  warn?: boolean;
  title?: string;
}) {
  return (
    <span className="flex items-baseline gap-1.5" title={title}>
      <span
        className={`text-[9px] tracking-widest uppercase ${warn ? "text-bp-warn/80" : "text-bp-faint"}`}
      >
        {label}
      </span>
      <span className={`tabular ${warn ? "text-bp-warn-ink" : "text-bp-text"}`}>{value}</span>
    </span>
  );
}

/** Trim a declaration name to something that fits beside the other readouts. */
function briefly(name: string): string {
  return name.length > 24 ? `${name.slice(0, 23)}…` : name;
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 text-[10px] tracking-widest uppercase transition-colors ${
        active
          ? "bg-bp-accent/12 text-bp-accent"
          : "text-bp-muted hover:text-bp-text"
      }`}
    >
      {children}
    </button>
  );
}

const TOOLBAR_BUTTON =
  "border border-bp-rule px-2.5 py-1 text-[10px] tracking-widest uppercase transition-colors hover:border-bp-accent hover:text-bp-accent";

function Workspace() {
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [graph, setGraph] = useState<ProjectGraph | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** When the graph on screen was taken, cached or fresh. */
  const [scannedAt, setScannedAt] = useState<string | null>(null);
  /** How far the graph on screen has drifted from disk, once we have checked. */
  const [freshness, setFreshness] = useState<Freshness | null>(null);
  /** Sticky file selection, from a click in the graph, the inspector, or the palette. */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** What the call view is built around: the selected file, or one function in it. */
  const [callAnchor, setCallAnchor] = useState<CallAnchor | null>(null);
  /** Transient, from the pointer being over a node in the graph. */
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("imports");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** What the source viewer is showing, or null while it is closed. */
  const [sourceTarget, setSourceTarget] = useState<SourceTarget | null>(null);
  /** A pending "bring this file into view", re-fired by the nonce on repeat picks. */
  const [revealRequest, setRevealRequest] = useState<{ id: string; nonce: number } | null>(null);

  const { setCenter, setViewport, getNode, getNodes, getZoom } = useReactFlow();
  const containerWidth = useStore((state) => state.width);
  const containerHeight = useStore((state) => state.height);

  /**
   * Frame the whole graph. This computes the viewport directly rather than
   * calling `fitView`, whose drain path defers through `requestAnimationFrame`
   * and so does nothing at all in a document that is not being painted.
   */
  const frameGraph = useCallback(
    (duration = 0) => {
      const flowNodes = getNodes();
      if (flowNodes.length === 0 || !containerWidth || !containerHeight) return;
      const bounds = getNodesBounds(flowNodes);
      setViewport(
        getViewportForBounds(bounds, containerWidth, containerHeight, MIN_ZOOM, MAX_FIT_ZOOM, 0.12),
        { duration },
      );
    },
    [getNodes, setViewport, containerWidth, containerHeight],
  );

  // React Flow owns node/edge state so the user can drag nodes around; we only
  // seed it whenever a different graph lands.
  const [nodes, setNodes, onNodesChange] = useNodesState([] as ReturnType<typeof toFlowGraph>["nodes"]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([] as ReturnType<typeof toFlowGraph>["edges"]);
  /** Bumped per graph to ask for the new layout to be framed. */
  const [fitRequest, setFitRequest] = useState(0);

  useEffect(() => {
    const laidOut = graph ? toFlowGraph(graph) : { nodes: [], edges: [] };
    setNodes(laidOut.nodes);
    setEdges(laidOut.edges);
    setSelectedId(null);
    setCallAnchor(null);
    setHoverId(null);
    if (laidOut.nodes.length > 0) setFitRequest((request) => request + 1);
  }, [graph, setNodes, setEdges]);

  // The `fitView` prop only fires when React Flow's store initialises, and the
  // store outlives any one graph now that the provider sits above it — so every
  // scan after the first has to ask for its own framing.
  useEffect(() => {
    if (fitRequest === 0) return;
    // Safe to frame immediately: child effects run first, so React Flow has
    // already taken the new nodes into its store by the time this runs.
    frameGraph();
  }, [fitRequest, frameGraph]);

  const index = useMemo(() => buildIndex(graph), [graph]);

  /**
   * The call graph is always anchored — to a file, or to a single function.
   * Whole-project function graphs run to thousands of nodes and read as noise,
   * so stepping outward is done by re-anchoring on a neighbour rather than
   * widening the radius.
   */
  const callView = useMemo(
    () => (tab === "calls" ? toCallView(graph?.symbols ?? [], graph?.calls ?? [], callAnchor) : EMPTY_CALL_VIEW),
    [tab, graph, callAnchor],
  );

  const showingCalls = tab === "calls";
  /** The anchored function, when the call view is built around one. */
  const anchoredSymbol =
    callAnchor?.kind === "symbol" ? (index.symbolsById.get(callAnchor.id) ?? null) : null;

  /** Files that have changed since the graph was taken; 0 when fresh or unknown. */
  const stale = freshness ? freshness.added + freshness.removed + freshness.modified : 0;

  /**
   * Hover wins over selection, so pointing at the graph always answers first.
   * The call view deliberately has no resting focus: everything on it already
   * touches the anchor, so highlighting all of it would say nothing. The anchor
   * itself is marked by its selected styling instead.
   */
  const focusId = showingCalls ? hoverId : (hoverId ?? selectedId);

  /** The focused node and everything it links to, in either direction. */
  const neighbourhood = useMemo(() => {
    if (!focusId) return null;
    if (!showingCalls) {
      const entry = index.byId.get(focusId);
      return new Set([focusId, ...(entry?.imports ?? []), ...(entry?.importedBy ?? [])]);
    }
    const related = new Set([focusId]);
    for (const edge of callView.edges) {
      if (edge.source === focusId) related.add(edge.target);
      if (edge.target === focusId) related.add(edge.source);
    }
    return related;
  }, [focusId, index, showingCalls, callView.edges]);

  /**
   * Decorate nodes with selection and dimming, reusing the node object whenever
   * neither actually changed. Returning fresh objects every render would make
   * React Flow diff them, emit changes, and re-render us straight back — a loop
   * that also cancels any viewport animation in flight.
   */
  const displayNodes = useMemo(
    () =>
      nodes.map((node) => {
        const selected = node.id === selectedId;
        const className = neighbourhood && !neighbourhood.has(node.id) ? "is-dimmed" : undefined;
        if (node.selected === selected && node.className === className) return node;
        return { ...node, selected, className };
      }),
    [nodes, neighbourhood, selectedId],
  );

  const displayEdges = useMemo<Edge[]>(() => {
    if (!focusId) return edges;
    return edges.map((edge) => {
      const attached = edge.source === focusId || edge.target === focusId;
      if (!attached) return { ...edge, className: "is-dimmed" };
      return {
        ...edge,
        style: { ...edge.style, stroke: ACCENT, strokeWidth: 1.6 },
        markerEnd: { ...(edge.markerEnd as EdgeMarker), color: ACCENT },
        zIndex: 1,
      };
    });
  }, [edges, focusId]);

  const activeNodes = useMemo(() => {
    if (!showingCalls) return displayNodes;
    return callView.nodes.map((node) => {
      const className = neighbourhood && !neighbourhood.has(node.id) ? "is-dimmed" : undefined;
      return className ? { ...node, className } : node;
    });
  }, [showingCalls, displayNodes, callView.nodes, neighbourhood]);

  const activeEdges = useMemo<Edge[]>(() => {
    if (!showingCalls) return displayEdges;
    if (!focusId) return callView.edges;
    return callView.edges.map((edge) => {
      if (edge.source === focusId || edge.target === focusId) {
        return {
          ...edge,
          style: { ...edge.style, stroke: ACCENT, strokeWidth: 1.6 },
          markerEnd: { ...(edge.markerEnd as EdgeMarker), color: ACCENT },
          zIndex: 1,
        };
      }
      // Keep whatever class the edge already carries, so a guessed call stays
      // dashed while it is dimmed.
      return { ...edge, className: [edge.className, "is-dimmed"].filter(Boolean).join(" ") };
    });
  }, [showingCalls, displayEdges, callView.edges, focusId]);

  // Re-frame whenever the visible graph changes: switching tab, or re-anchoring
  // the call view on a different file.
  useEffect(() => {
    setFitRequest((request) => request + 1);
  }, [tab, callView]);

  /**
   * Pick a file, or clear the pick. Selection and the call anchor move together:
   * they are two views of one choice, and letting them drift apart is what makes
   * the Calls tab open on a graph of whatever the user was looking at before.
   */
  const selectFile = useCallback((id: string | null) => {
    setSelectedId(id);
    setCallAnchor(id ? { kind: "file", id } : null);
  }, []);

  /**
   * Select a file and bring it into view. The centring has to wait for the
   * selection render to commit: panning in the same tick as a state update gets
   * cancelled, because the re-render syncs the pre-animation viewport back into
   * the pan/zoom handler and kills the transition in flight.
   */
  const revealFile = useCallback((id: string) => {
    selectFile(id);
    setRevealRequest((previous) => ({ id, nonce: (previous?.nonce ?? 0) + 1 }));
  }, [selectFile]);

  useEffect(() => {
    if (!revealRequest) return;
    const node = getNode(revealRequest.id);
    if (!node) return;
    setCenter(
      node.position.x + (node.width ?? 0) / 2,
      node.position.y + (node.height ?? 0) / 2,
      // Keep the user's zoom unless they are so far out that the file would be
      // an unreadable speck once centred.
      { zoom: Math.max(getZoom(), 0.8), duration: 380 },
    );
  }, [revealRequest, getNode, setCenter, getZoom]);

  /**
   * Ask how far the graph has drifted from disk. Each file is compared against
   * its own recorded size and modification time rather than against the moment
   * of the scan, so a `git clone` does not call an untouched tree stale.
   */
  const checkFreshness = useCallback(async (path: string, fingerprint?: FileStamp[]) => {
    if (!fingerprint) {
      // Cached before fingerprints existed: there is nothing to compare against,
      // and claiming the graph is current would be a guess.
      setFreshness(null);
      return;
    }
    try {
      setFreshness(await invoke<Freshness>("check_freshness", { path, fingerprint }));
    } catch {
      // A project that has moved or been deleted does not warrant an error
      // banner here; asking for a scan will say so plainly enough.
      setFreshness(null);
    }
  }, []);

  /** Show the stored graph for a project, if there is one. */
  const showCached = useCallback(
    async (path: string) => {
      const cached = await loadCachedScan(path);
      setGraph(cached?.graph ?? null);
      setScannedAt(cached?.scannedAt ?? null);
      setFreshness(null);
      if (cached) await checkFreshness(path, cached.graph.fingerprint);
    },
    [checkFreshness],
  );

  // Coming back from the editor is exactly when the graph may have gone stale,
  // so re-check on focus. The walk only stats files — no parsing — which is
  // around 80ms on a four-thousand-file project.
  useEffect(() => {
    const fingerprint = graph?.fingerprint;
    if (!projectPath || !fingerprint) return;
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) void checkFreshness(projectPath, fingerprint);
    });
    return () => void unlisten.then((stop) => stop());
  }, [projectPath, graph, checkFreshness]);

  // Reopen whatever project was last in use, with its graph, so a relaunch does
  // not need a rescan.
  useEffect(() => {
    (async () => {
      try {
        const last = await loadLastProject();
        if (!last) return;
        setProjectPath(last);
        await showCached(last);
      } catch (err) {
        setError(`Could not read the scan cache: ${err}`);
      }
    })();
  }, [showCached]);

  const pickFolder = useCallback(async () => {
    setError(null);
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected !== "string") return;

      setProjectPath(selected);
      // The old graph belongs to the old folder; drop it rather than show it
      // under a path it did not come from.
      setGraph(null);
      setScannedAt(null);
      setFreshness(null);
      await saveLastProject(selected);
      await showCached(selected);
    } catch (err) {
      setError(String(err));
    }
  }, [showCached]);

  const scan = useCallback(async () => {
    if (!projectPath) return;
    setScanning(true);
    setError(null);
    try {
      const scanned = await invoke<ProjectGraph>("scan_project", { path: projectPath });
      setGraph(scanned);
      // The graph now matches disk by construction; no need to walk it again to
      // find that out.
      setFreshness({ added: 0, removed: 0, modified: 0 });
      setScannedAt(new Date().toISOString());
      // A failed write should not throw away a scan the user is already looking at.
      try {
        setScannedAt(await saveScan(projectPath, scanned));
      } catch (err) {
        setError(`Scan finished but could not be cached: ${err}`);
      }
    } catch (err) {
      setError(String(err));
      setGraph(null);
      setScannedAt(null);
      setFreshness(null);
    } finally {
      setScanning(false);
    }
  }, [projectPath]);

  /** Absolute path for a project-relative file id, which the reader needs. */
  const pathOf = useCallback((file: string) => index.byId.get(file)?.path ?? null, [index]);

  /** Show a whole file's source. */
  const showFileSource = useCallback(
    (file: string) => {
      const path = pathOf(file);
      if (path) setSourceTarget({ path, file, name: null, container: null });
    },
    [pathOf],
  );

  /**
   * Chart one function on its own: its callers on the left, what it calls on the
   * right, each labelled with the file it lives in. Selecting the declaring file
   * alongside it keeps the inspector pointed at where the function came from,
   * which is what makes hopping from one to the next legible.
   */
  const anchorSymbol = useCallback(
    (id: string) => {
      const symbol = index.symbolsById.get(id);
      if (!symbol) return;
      setSelectedId(symbol.file);
      // Re-anchoring on the symbol already anchored would lay the same graph out
      // again and re-frame it, so clicking the middle of the canvas to re-read
      // its source would throw away the pan and zoom the user had settled on.
      setCallAnchor((current) =>
        current?.kind === "symbol" && current.id === id ? current : { kind: "symbol", id },
      );
      setTab("calls");
    },
    [index],
  );

  /** Show a function's source, wherever it lives. */
  const showSymbolSource = useCallback(
    (id: string) => {
      const symbol = index.symbolsById.get(id);
      const path = symbol && pathOf(symbol.file);
      if (!symbol || !path) return;
      setSourceTarget({
        path,
        file: symbol.file,
        name: symbol.name,
        container: symbol.container,
      });
    },
    [index, pathOf],
  );

  const actions = useMemo<PaletteAction[]>(
    () => [
      { id: "open", label: "Open project…", hint: "⌘O", run: pickFolder },
      {
        id: "scan",
        label: scannedAt ? "Rescan project" : "Scan project",
        hint: "⌘R",
        disabled: !projectPath || scanning,
        run: scan,
      },
      {
        id: "tab",
        label: showingCalls ? "Show import graph" : "Show call graph",
        hint: "⌘T",
        run: () => setTab(showingCalls ? "imports" : "calls"),
      },
      {
        id: "inspector",
        label: inspectorOpen ? "Hide inspector" : "Show inspector",
        hint: "⌘B",
        run: () => setInspectorOpen((value) => !value),
      },
    ],
    [pickFolder, scan, scannedAt, projectPath, scanning, inspectorOpen, showingCalls],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      } else if (meta && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setInspectorOpen((value) => !value);
      } else if (meta && event.key.toLowerCase() === "t") {
        event.preventDefault();
        setTab((current) => (current === "calls" ? "imports" : "calls"));
      } else if (meta && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void pickFolder();
      } else if (meta && event.key.toLowerCase() === "r") {
        event.preventDefault();
        void scan();
      } else if (event.key === "Escape" && !paletteOpen && !sourceTarget) {
        // Esc steps back out rather than clearing everything: a function returns
        // to the file that declares it, so a chain of hops has a way home. An
        // open reader owns Esc first, so dismissing it never also costs the
        // anchor the user was reading about.
        if (anchoredSymbol) selectFile(anchoredSymbol.file);
        else selectFile(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pickFolder, scan, paletteOpen, sourceTarget, anchoredSymbol, selectFile]);

  return (
    <div className="flex h-full flex-col bg-bp-canvas font-mono text-bp-text">
      {/* The traffic lights float over this bar, so it doubles as the drag region. */}
      <header
        data-tauri-drag-region
        className="flex shrink-0 items-center gap-3 border-b border-bp-rule bg-bp-void py-2.5 pr-4 pl-[86px]"
      >
        <span className="text-[11px] font-semibold tracking-[0.22em] text-bp-accent select-none">
          MERIDIAN
        </span>

        <span className="h-4 w-px bg-bp-rule" />

        <button onClick={pickFolder} className={`${TOOLBAR_BUTTON} text-bp-muted`}>
          Open
        </button>

        {/* Amber whenever the graph has fallen behind disk, tying the button to
            the change count in the readouts on the far right. */}
        <button
          onClick={scan}
          disabled={!projectPath || scanning}
          title={freshness && stale > 0 ? describeChanges(freshness) : undefined}
          className={`px-2.5 py-1 text-[10px] tracking-widest uppercase transition-colors disabled:cursor-not-allowed disabled:border-bp-rule disabled:bg-transparent disabled:text-bp-faint ${
            stale > 0
              ? "border border-bp-warn bg-bp-warn text-bp-canvas hover:bg-bp-warn-ink hover:border-bp-warn-ink"
              : "border border-bp-accent/50 bg-bp-accent/8 text-bp-accent hover:bg-bp-accent/16"
          }`}
        >
          {scanning ? "Scanning" : scannedAt ? "Rescan" : "Scan"}
        </button>

        <span className="flex border border-bp-rule">
          <TabButton active={tab === "imports"} onClick={() => setTab("imports")}>
            Imports
          </TabButton>
          <TabButton active={tab === "calls"} onClick={() => setTab("calls")}>
            Calls
          </TabButton>
        </span>

        <button
          onClick={() => setPaletteOpen(true)}
          className={`${TOOLBAR_BUTTON} text-bp-muted`}
          title="Command palette"
        >
          ⌘K
        </button>

        <span
          className="min-w-0 flex-1 truncate text-[11px] text-bp-muted"
          title={projectPath ?? ""}
        >
          {projectPath ?? "— no project —"}
        </span>

        {graph && (
          <span className="flex shrink-0 items-center gap-4 text-[11px]">
            {showingCalls ? (
              <>
                {anchoredSymbol ? (
                  <>
                    <Readout
                      label="tracing"
                      value={briefly(anchoredSymbol.label)}
                      title={anchoredSymbol.id}
                    />
                    <Readout label="callers" value={callView.callerCount} />
                    <Readout label="callees" value={callView.calleeCount} />
                  </>
                ) : (
                  <>
                    <Readout label="in file" value={callView.ownCount} />
                    <Readout label="linked" value={callView.neighbourCount} />
                  </>
                )}
                <Readout
                  label="calls"
                  value={
                    callView.guessCount
                      ? `${callView.edges.length} (${callView.guessCount}?)`
                      : callView.edges.length
                  }
                />
              </>
            ) : (
              <>
                <Readout label="files" value={graph.nodes.length} />
                <Readout label="imports" value={graph.edges.length} />
              </>
            )}
            <Readout label="scan" value={scannedAt ? describeAge(scannedAt) : "live"} />
            {freshness && stale > 0 && (
              <Readout
                label="changed"
                value={stale}
                warn
                title={`${describeChanges(freshness)} — rescan to bring the graph up to date`}
              />
            )}
          </span>
        )}
      </header>

      {error && (
        <div className="shrink-0 border-b border-bp-danger/40 bg-bp-danger/10 px-4 py-2 text-[11px] text-bp-danger">
          {error}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {inspectorOpen && graph && (
          <Inspector
            index={index}
            selectedId={selectedId}
            anchoredSymbol={anchoredSymbol?.id ?? null}
            onSelect={revealFile}
            onSelectSymbol={(id) => {
              anchorSymbol(id);
              showSymbolSource(id);
            }}
          />
        )}

        <main className="min-h-0 min-w-0 flex-1">
          {activeNodes.length > 0 ? (
            <ReactFlow
              nodes={activeNodes}
              edges={activeEdges}
              onNodesChange={showingCalls ? undefined : onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeMouseEnter={(_, node: Node) => setHoverId(node.id)}
              onNodeMouseLeave={() => setHoverId(null)}
              onNodeClick={(_, node: Node) => {
                if (!showingCalls) {
                  selectFile(node.id);
                  showFileSource(node.id);
                  return;
                }
                // Clicking a function makes it the subject: one click per hop is
                // what turns the call view into something you can walk.
                const symbolId = String(node.data?.id ?? "");
                anchorSymbol(symbolId);
                showSymbolSource(symbolId);
              }}
              onPaneClick={() => !showingCalls && selectFile(null)}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              minZoom={0.05}
              proOptions={{ hideAttribution: true }}
              colorMode="light"
            >
              {/* Fine and coarse rules together read as drafting paper. */}
              <Background
                id="fine"
                variant={BackgroundVariant.Lines}
                gap={18}
                lineWidth={1}
                color="rgba(122,102,74,0.07)"
              />
              <Background
                id="coarse"
                variant={BackgroundVariant.Lines}
                gap={108}
                lineWidth={1}
                color="rgba(122,102,74,0.16)"
              />
              <LevelOfDetail />
              <CanvasHud onFit={() => frameGraph(320)} />
              <MiniMap
                pannable
                zoomable
                nodeColor={(node) => hueInk(Number(node.data?.hue ?? DEFAULT_HUE))}
                nodeStrokeWidth={0}
                maskColor="rgba(251,247,239,0.72)"
              />
            </ReactFlow>
          ) : (
            <div className="bp-grid flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <p className="text-[11px] tracking-[0.2em] text-bp-muted uppercase">
                {!projectPath
                  ? "No project loaded"
                  : scanning
                    ? "Scanning project"
                    : !graph
                      ? "Awaiting scan"
                      : showingCalls
                        ? !graph.symbols
                          ? "Rescan needed"
                          : callAnchor
                            ? "Nothing to chart"
                            : "Nothing anchored"
                        : "Awaiting scan"}
              </p>
              <p className="max-w-md text-[11px] text-bp-faint">
                {!projectPath
                  ? "Open a TypeScript project to begin."
                  : !graph
                    ? "Run a scan to chart this project's imports."
                    : showingCalls
                      ? !graph.symbols
                        ? "This project was scanned before function analysis existed. Rescan to chart its calls."
                        : callAnchor
                          ? callAnchor.kind === "symbol"
                            ? `${callAnchor.id} is not in this scan. Rescan to chart it.`
                            : `${callAnchor.id} declares no functions, methods or classes.`
                          : "Pick a file or function in the inspector or with ⌘K to chart the calls into and out of it."
                      : "Run a scan to chart this project's imports."}
              </p>
            </div>
          )}
        </main>

        <SourceDrawer
          target={sourceTarget}
          onClose={() => setSourceTarget(null)}
          onFocusFile={(file) => {
            // Widen the call view from one function back out to its whole file.
            revealFile(file);
            setTab("calls");
            setSourceTarget(null);
          }}
        />
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        index={index}
        actions={actions}
        onSelectFile={revealFile}
        onSelectSymbol={(id) => {
          anchorSymbol(id);
          showSymbolSource(id);
        }}
      />
    </div>
  );
}

export default function App() {
  // The provider sits outside the canvas so the inspector and palette can drive
  // the viewport even while React Flow is remounting on a new graph.
  return (
    <ReactFlowProvider>
      <Workspace />
    </ReactFlowProvider>
  );
}
