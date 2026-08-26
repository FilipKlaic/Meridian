import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type EdgeMarker,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { CanvasHud, LevelOfDetail } from "./CanvasHud";
import FileNode from "./FileNode";
import { loadCachedScan, loadLastProject, saveLastProject, saveScan } from "./db";
import { toFlowGraph } from "./layout";
import type { ProjectGraph } from "./types";

const nodeTypes = { file: FileNode };

/** Short, human-readable age of a cached scan. */
function describeAge(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function Readout({ label, value }: { label: string; value: string | number }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-[9px] tracking-widest text-bp-muted/60 uppercase">{label}</span>
      <span className="tabular text-bp-text">{value}</span>
    </span>
  );
}

export default function App() {
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [graph, setGraph] = useState<ProjectGraph | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set while the displayed graph came from the cache rather than a fresh scan. */
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  /** Node the pointer is over, which everything unrelated dims away from. */
  const [focusId, setFocusId] = useState<string | null>(null);

  // React Flow owns node/edge state so the user can drag nodes around; we only
  // seed it whenever a different graph lands.
  const [nodes, setNodes, onNodesChange] = useNodesState([] as ReturnType<typeof toFlowGraph>["nodes"]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([] as ReturnType<typeof toFlowGraph>["edges"]);
  // Bumped per graph so React Flow remounts and re-runs `fitView` on the new layout.
  const [graphKey, setGraphKey] = useState(0);

  useEffect(() => {
    const laidOut = graph ? toFlowGraph(graph) : { nodes: [], edges: [] };
    setNodes(laidOut.nodes);
    setEdges(laidOut.edges);
    setFocusId(null);
    setGraphKey((key) => key + 1);
  }, [graph, setNodes, setEdges]);

  /** The focused file and everything it links to, in either direction. */
  const neighbourhood = useMemo(() => {
    if (!focusId) return null;
    const related = new Set([focusId]);
    for (const edge of edges) {
      if (edge.source === focusId) related.add(edge.target);
      if (edge.target === focusId) related.add(edge.source);
    }
    return related;
  }, [focusId, edges]);

  const displayNodes = useMemo(
    () =>
      neighbourhood
        ? nodes.map((node) => ({
            ...node,
            className: neighbourhood.has(node.id) ? undefined : "is-dimmed",
          }))
        : nodes,
    [nodes, neighbourhood],
  );

  const displayEdges = useMemo<Edge[]>(() => {
    if (!focusId) return edges;
    return edges.map((edge) => {
      const attached = edge.source === focusId || edge.target === focusId;
      if (!attached) return { ...edge, className: "is-dimmed" };
      return {
        ...edge,
        style: { ...edge.style, stroke: "#38bdf8", strokeWidth: 1.6 },
        markerEnd: { ...(edge.markerEnd as EdgeMarker), color: "#38bdf8" },
        zIndex: 1,
      };
    });
  }, [edges, focusId]);

  /** Show the stored graph for a project, if there is one. */
  const showCached = useCallback(async (path: string) => {
    const cached = await loadCachedScan(path);
    setGraph(cached?.graph ?? null);
    setCachedAt(cached?.scannedAt ?? null);
  }, []);

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
      setCachedAt(null);
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
      setCachedAt(null);
      // A failed write should not throw away a scan the user is already looking at.
      try {
        await saveScan(projectPath, scanned);
      } catch (err) {
        setError(`Scan finished but could not be cached: ${err}`);
      }
    } catch (err) {
      setError(String(err));
      setGraph(null);
      setCachedAt(null);
    } finally {
      setScanning(false);
    }
  }, [projectPath]);

  return (
    <div className="flex h-full flex-col bg-bp-canvas font-mono text-bp-text">
      {/* The traffic lights float over this bar, so it doubles as the drag region. */}
      <header
        data-tauri-drag-region
        className="flex shrink-0 items-center gap-3 border-b border-bp-rule bg-bp-void/90 py-2.5 pr-4 pl-[86px]"
      >
        <span className="text-[11px] font-semibold tracking-[0.22em] text-bp-accent select-none">
          MERIDIAN
        </span>

        <span className="h-4 w-px bg-bp-rule" />

        <button
          onClick={pickFolder}
          className="border border-bp-rule px-2.5 py-1 text-[10px] tracking-widest text-bp-muted uppercase transition-colors hover:border-bp-accent hover:text-bp-accent"
        >
          Open
        </button>

        <button
          onClick={scan}
          disabled={!projectPath || scanning}
          className="border border-bp-accent/60 bg-bp-accent/10 px-2.5 py-1 text-[10px] tracking-widest text-bp-accent uppercase transition-colors hover:bg-bp-accent/20 disabled:cursor-not-allowed disabled:border-bp-rule disabled:bg-transparent disabled:text-bp-muted/40"
        >
          {scanning ? "Scanning" : cachedAt ? "Rescan" : "Scan"}
        </button>

        <span
          className="min-w-0 flex-1 truncate text-[11px] text-bp-muted"
          title={projectPath ?? ""}
        >
          {projectPath ?? "— no project —"}
        </span>

        {graph && (
          <span className="flex shrink-0 items-center gap-4 text-[11px]">
            <Readout label="files" value={graph.nodes.length} />
            <Readout label="imports" value={graph.edges.length} />
            <Readout label="scan" value={cachedAt ? describeAge(cachedAt) : "live"} />
          </span>
        )}
      </header>

      {error && (
        <div className="shrink-0 border-b border-red-900/60 bg-red-950/50 px-4 py-2 text-[11px] text-red-300">
          {error}
        </div>
      )}

      <main className="min-h-0 flex-1">
        {nodes.length > 0 ? (
          <ReactFlow
            key={graphKey}
            nodes={displayNodes}
            edges={displayEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeMouseEnter={(_, node: Node) => setFocusId(node.id)}
            onNodeMouseLeave={() => setFocusId(null)}
            onPaneClick={() => setFocusId(null)}
            nodeTypes={nodeTypes}
            fitView
            minZoom={0.05}
            proOptions={{ hideAttribution: true }}
            colorMode="dark"
          >
            {/* Fine and coarse rules together read as drafting paper. */}
            <Background
              id="fine"
              variant={BackgroundVariant.Lines}
              gap={18}
              lineWidth={1}
              color="rgba(56,189,248,0.045)"
            />
            <Background
              id="coarse"
              variant={BackgroundVariant.Lines}
              gap={108}
              lineWidth={1}
              color="rgba(56,189,248,0.1)"
            />
            <LevelOfDetail />
            <CanvasHud />
            <MiniMap
              pannable
              zoomable
              nodeColor={(node) => `hsl(${Number(node.data?.hue ?? 190)} 70% 55%)`}
              nodeStrokeWidth={0}
              maskColor="rgba(4,12,22,0.72)"
            />
          </ReactFlow>
        ) : (
          <div className="bp-grid flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-[11px] tracking-[0.2em] text-bp-muted uppercase">
              {projectPath ? (scanning ? "Scanning project" : "Awaiting scan") : "No project loaded"}
            </p>
            <p className="text-[11px] text-bp-muted/60">
              {projectPath
                ? "Run a scan to chart this project's imports."
                : "Open a TypeScript project to begin."}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
