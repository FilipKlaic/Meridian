import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

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

export default function App() {
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [graph, setGraph] = useState<ProjectGraph | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set while the displayed graph came from the cache rather than a fresh scan. */
  const [cachedAt, setCachedAt] = useState<string | null>(null);

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
    setGraphKey((key) => key + 1);
  }, [graph, setNodes, setEdges]);

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
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-4 py-3">
        <h1 className="text-sm font-semibold tracking-tight">Meridian</h1>

        <button
          onClick={pickFolder}
          className="rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium hover:bg-slate-700"
        >
          Pick folder
        </button>

        <button
          onClick={scan}
          disabled={!projectPath || scanning}
          className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {scanning ? "Scanning…" : cachedAt ? "Rescan" : "Scan"}
        </button>

        <span className="min-w-0 flex-1 truncate text-xs text-slate-400" title={projectPath ?? ""}>
          {projectPath ?? "No folder selected"}
        </span>

        {graph && (
          <span className="shrink-0 text-xs text-slate-400">
            {graph.nodes.length} files · {graph.edges.length} imports
            {cachedAt && <> · cached {describeAge(cachedAt)}</>}
          </span>
        )}
      </header>

      {error && (
        <div className="border-b border-red-900 bg-red-950 px-4 py-2 text-xs text-red-200">{error}</div>
      )}

      <main className="min-h-0 flex-1">
        {nodes.length > 0 ? (
          <ReactFlow
            key={graphKey}
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            fitView
            minZoom={0.05}
            proOptions={{ hideAttribution: true }}
            colorMode="dark"
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#1e293b" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor="#64748b" maskColor="rgba(2,6,23,0.6)" />
          </ReactFlow>
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-slate-500">
            {projectPath
              ? scanning
                ? "Scanning project…"
                : "Click Scan to build the import graph."
              : "Pick a TypeScript project folder to get started."}
          </div>
        )}
      </main>
    </div>
  );
}
