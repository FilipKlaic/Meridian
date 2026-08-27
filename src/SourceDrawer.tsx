import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

/** What the viewer was asked to show. */
export type SourceTarget = {
  /** Absolute path on disk. */
  path: string;
  /** Project-relative file id, shown under the title. */
  file: string;
  /** Declaration name, or null to show the whole file. */
  name: string | null;
  /** Enclosing class, for a method. */
  container: string | null;
  /** True when this symbol lives outside the file the call view is anchored on. */
  external?: boolean;
};

type SourceView = {
  text: string;
  start_line: number;
  end_line: number;
  truncated: boolean;
};

export default function SourceDrawer({
  target,
  onClose,
  onFocusFile,
}: {
  target: SourceTarget | null;
  onClose: () => void;
  onFocusFile: (file: string) => void;
}) {
  const [view, setView] = useState<SourceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setView(null);

    invoke<SourceView>("read_source", {
      path: target.path,
      name: target.name,
      container: target.container,
    })
      .then((result) => {
        if (!cancelled) setView(result);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [target, onClose]);

  if (!target) return null;

  // For a whole file the title is just its name, so the path below it is not a
  // duplicate of the line above.
  const title = target.name
    ? target.container
      ? `${target.container}.${target.name}`
      : target.name
    : (target.file.split("/").pop() ?? target.file);
  const lines = view ? view.text.split("\n") : [];
  const gutterWidth = String(view ? view.end_line : 1).length;

  return (
    <aside className="flex w-[30rem] shrink-0 flex-col border-l border-bp-rule bg-bp-void">
      <header className="flex shrink-0 items-start gap-2 border-b border-bp-rule px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[11px] text-bp-text" title={title}>
            {title}
          </p>
          <p className="truncate font-mono text-[9px] text-bp-faint" title={target.path}>
            {target.file}
            {view && !target.name ? "" : view ? ` · ${view.start_line}–${view.end_line}` : ""}
          </p>
        </div>

        {target.external && (
          <button
            onClick={() => onFocusFile(target.file)}
            title="Chart this file's calls"
            className="shrink-0 border border-bp-rule px-2 py-1 text-[9px] tracking-widest text-bp-muted uppercase transition-colors hover:border-bp-accent hover:text-bp-accent"
          >
            Focus
          </button>
        )}

        <button
          onClick={() =>
            openUrl(`vscode://file/${target.path}:${view?.start_line ?? 1}`).catch(() => {
              setError("Could not hand this file to VS Code.");
            })
          }
          title="Open in VS Code"
          className="shrink-0 border border-bp-rule px-2 py-1 text-[9px] tracking-widest text-bp-muted uppercase transition-colors hover:border-bp-accent hover:text-bp-accent"
        >
          Edit
        </button>

        <button
          onClick={onClose}
          title="Close (Esc)"
          className="shrink-0 border border-bp-rule px-2 py-1 text-[9px] text-bp-muted transition-colors hover:border-bp-accent hover:text-bp-accent"
        >
          ✕
        </button>
      </header>

      <div className="bp-scroll min-h-0 flex-1 overflow-auto">
        {loading && <p className="px-3 py-4 text-[11px] text-bp-faint">Reading…</p>}

        {error && (
          <p className="m-3 border border-bp-warn/40 bg-bp-warn/10 px-3 py-2 text-[11px] text-bp-warn-ink">
            {error}
          </p>
        )}

        {view && (
          <pre className="px-3 py-2 font-mono text-[11px] leading-[1.55]">
            {lines.map((line, i) => (
              <div key={i} className="flex">
                <span
                  className="tabular mr-3 shrink-0 text-right text-bp-faint select-none"
                  style={{ width: `${gutterWidth}ch` }}
                >
                  {view.start_line + i}
                </span>
                <span className="whitespace-pre text-bp-text">{line || " "}</span>
              </div>
            ))}
          </pre>
        )}

        {view?.truncated && (
          <p className="px-3 pb-3 text-[10px] text-bp-faint">
            Long file — showing the first {view.end_line} lines.
          </p>
        )}
      </div>
    </aside>
  );
}
