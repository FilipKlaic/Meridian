import { Handle, Position, type NodeProps } from "@xyflow/react";

import { DEFAULT_HUE } from "./layout";

/** One file in the graph, drawn as an instrument panel. */
export default function FileNode({ data, selected }: NodeProps) {
  const label = String(data.label ?? "");
  const id = String(data.id ?? "");
  const extension = String(data.extension ?? "");
  const inDegree = Number(data.inDegree ?? 0);
  const outDegree = Number(data.outDegree ?? 0);
  const hue = Number(data.hue ?? DEFAULT_HUE);

  return (
    <div
      title={id}
      style={{ "--hue": hue } as React.CSSProperties}
      // The box is sized by the layout, so fill whatever React Flow allocates.
      className={`bp-node relative flex h-full w-full flex-col justify-center px-3 ${
        selected ? "is-selected" : ""
      }`}
    >
      <Handle type="target" position={Position.Left} />

      <span className="bp-corner bp-corner-tl" />
      <span className="bp-corner bp-corner-tr" />
      <span className="bp-corner bp-corner-bl" />
      <span className="bp-corner bp-corner-br" />

      <div className="node-name truncate font-mono text-[11px] leading-tight font-medium text-bp-text">
        {label}
      </div>
      <div className="node-detail tabular mt-0.5 truncate font-mono text-[9px] leading-tight tracking-wide text-bp-muted uppercase">
        {extension} · {inDegree} in · {outDegree} out
      </div>

      <Handle type="source" position={Position.Right} />
    </div>
  );
}
