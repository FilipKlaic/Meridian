import { useEffect } from "react";
import { Panel, useReactFlow, useStore } from "@xyflow/react";


/**
 * Swaps detail in and out by zoom band. Reading the zoom in one small component
 * and toggling a class on the container keeps every node out of the re-render,
 * which matters once a graph runs to hundreds of files.
 */
export function LevelOfDetail() {
  const zoom = useStore((state) => state.transform[2]);
  const domNode = useStore((state) => state.domNode);

  useEffect(() => {
    if (!domNode) return;
    domNode.classList.toggle("lod-far", zoom < 0.4);
    domNode.classList.toggle("lod-medium", zoom >= 0.4 && zoom < 0.72);
  }, [zoom, domNode]);

  return null;
}

const BUTTON =
  "h-6 w-6 border border-bp-rule text-bp-muted hover:border-bp-accent hover:text-bp-accent transition-colors";

/** Zoom controls and viewport readout, in the register of an instrument panel. */
export function CanvasHud({ onFit }: { onFit: () => void }) {
  const zoom = useStore((state) => state.transform[2]);
  const { zoomIn, zoomOut } = useReactFlow();

  return (
    <Panel
      position="bottom-left"
      className="flex items-stretch gap-px border border-bp-rule bg-bp-void/80 p-1 font-mono text-[10px] backdrop-blur"
    >
      <button className={BUTTON} onClick={() => zoomOut()} title="Zoom out">
        −
      </button>
      <button className={BUTTON} onClick={() => zoomIn()} title="Zoom in">
        +
      </button>
      <button className={`${BUTTON} w-auto px-2`} onClick={onFit} title="Fit to view">
        FIT
      </button>
      <span className="tabular flex w-12 items-center justify-end px-1 text-bp-muted">
        {Math.round(zoom * 100)}%
      </span>
    </Panel>
  );
}
