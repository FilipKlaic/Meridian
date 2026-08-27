import { Handle, Position, type NodeProps } from "@xyflow/react";

import { DEFAULT_HUE } from "./layout";

/**
 * One function, method or class in the call graph. Symbols from outside the
 * focused file are drawn flatter, so the file you are looking at reads as the
 * subject and its neighbours as context.
 */
export default function SymbolNode({ data, selected }: NodeProps) {
  const label = String(data.label ?? "");
  const detail = String(data.detail ?? "");
  const hue = Number(data.hue ?? DEFAULT_HUE);
  const external = Boolean(data.external);
  const exported = Boolean(data.exported);

  return (
    <div
      title={String(data.id ?? "")}
      style={{ "--hue": hue } as React.CSSProperties}
      className={`bp-node relative flex h-full w-full flex-col justify-center px-3 ${
        selected ? "is-selected" : ""
      } ${external ? "is-external" : ""}`}
    >
      <Handle type="target" position={Position.Left} />

      <span className="bp-corner bp-corner-tl" />
      <span className="bp-corner bp-corner-tr" />
      <span className="bp-corner bp-corner-bl" />
      <span className="bp-corner bp-corner-br" />

      <div className="node-name flex items-center gap-1.5">
        <span className="truncate font-mono text-[11px] leading-tight font-medium text-bp-text">
          {label}
        </span>
        {exported && (
          <span
            title="exported"
            className="shrink-0 font-mono text-[8px] leading-none tracking-widest text-bp-accent"
          >
            EX
          </span>
        )}
      </div>
      <div className="node-detail tabular mt-0.5 truncate font-mono text-[9px] leading-tight tracking-wide text-bp-muted uppercase">
        {detail}
      </div>

      <Handle type="source" position={Position.Right} />
    </div>
  );
}
