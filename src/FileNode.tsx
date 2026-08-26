import { Handle, Position, type NodeProps } from "@xyflow/react";

/** One file in the graph. The full project-relative path is the tooltip. */
export default function FileNode({ data, selected }: NodeProps) {
  const label = String(data.label ?? "");
  const id = String(data.id ?? "");

  return (
    <div
      title={id}
      // The box is sized by the layout, so fill whatever React Flow allocates.
      className={`flex h-full w-full items-center rounded-md border px-3 text-xs font-medium transition-colors ${
        selected
          ? "border-sky-400 bg-sky-950 text-sky-100"
          : "border-slate-700 bg-slate-800 text-slate-200"
      }`}
    >
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-slate-500" />
      <span className="truncate">{label}</span>
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-slate-500" />
    </div>
  );
}
