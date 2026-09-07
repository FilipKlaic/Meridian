import { useEffect, useMemo, useRef, useState } from "react";

import Highlight from "./Highlight";
import { rank } from "./fuzzy";
import type { GraphIndex } from "./graphIndex";
import { directoryColor } from "./layout";

export type PaletteAction = {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  run: () => void;
};

type Item =
  | { kind: "file"; key: string; text: string; label: string; directory: string; id: string }
  | { kind: "symbol"; key: string; text: string; label: string; file: string; id: string }
  | { kind: "action"; key: string; text: string; action: PaletteAction };

export default function CommandPalette({
  open,
  onClose,
  index,
  actions,
  onSelectFile,
  onSelectSymbol,
}: {
  open: boolean;
  onClose: () => void;
  index: GraphIndex;
  actions: PaletteAction[];
  onSelectFile: (id: string) => void;
  onSelectSymbol: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo<Item[]>(
    () => [
      ...actions.map((action) => ({
        kind: "action" as const,
        key: `action:${action.id}`,
        text: action.label,
        action,
      })),
      ...index.entries.map((entry) => ({
        kind: "file" as const,
        key: `file:${entry.id}`,
        text: entry.id,
        label: entry.label,
        directory: entry.directory,
        id: entry.id,
      })),
      // Symbol ids are `file#name`, so one query reaches both halves: `authreq`
      // finds `src/auth.ts#requireUser` through the path, `requireuser` through
      // the name — and the ranker's after-the-last-slash bonus already favours
      // the name, which is what someone typing a function name meant.
      ...index.symbols.map((symbol) => ({
        kind: "symbol" as const,
        key: `symbol:${symbol.id}`,
        text: symbol.id,
        label: symbol.label,
        file: symbol.file,
        id: symbol.id,
      })),
    ],
    [actions, index.entries, index.symbols],
  );

  const results = useMemo(() => rank(query, items, (item) => item.text).slice(0, 60), [query, items]);

  // Reset each time it opens, so it never reopens mid-search.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => setActive(0), [query]);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const choose = (item: Item) => {
    if (item.kind === "action") {
      if (item.action.disabled) return;
      item.action.run();
    } else if (item.kind === "symbol") {
      onSelectSymbol(item.id);
    } else {
      onSelectFile(item.id);
    }
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
      event.preventDefault();
      setActive((current) => (results.length ? (current + 1) % results.length : 0));
    } else if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
      event.preventDefault();
      setActive((current) => (results.length ? (current - 1 + results.length) % results.length : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = results[active];
      if (chosen) choose(chosen.item);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-bp-scrim/15 pt-[14vh] backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        className="flex h-fit max-h-[62vh] w-[min(560px,88vw)] flex-col border border-bp-rule bg-bp-panel shadow-2xl shadow-bp-scrim/30"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Jump to a file or function, or run a command…"
          spellCheck={false}
          className="shrink-0 border-b border-bp-rule bg-transparent px-3.5 py-3 font-mono text-[12px] text-bp-text placeholder:text-bp-faint focus:outline-none"
        />

        <div ref={listRef} className="bp-scroll min-h-0 flex-1 overflow-y-auto py-1">
          {results.length === 0 && (
            <p className="px-3.5 py-6 text-center text-[11px] text-bp-faint">Nothing matches.</p>
          )}

          {results.map(({ item, match }, i) => {
            const isActive = i === active;
            return (
              <button
                key={item.key}
                data-active={isActive}
                onMouseMove={() => setActive(i)}
                onClick={() => choose(item)}
                className={`flex w-full items-center gap-2.5 px-3.5 py-1.5 text-left font-mono text-[11px] ${
                  isActive ? "bg-bp-hover" : ""
                } ${item.kind === "action" && item.action.disabled ? "opacity-35" : ""}`}
              >
                {item.kind === "file" ? (
                  <>
                    <span
                      className="size-1.5 shrink-0"
                      style={{ background: directoryColor(item.id) }}
                    />
                    <span className="truncate text-bp-text">{item.label}</span>
                    <span className="ml-auto shrink-0 truncate text-[9px] text-bp-faint">
                      <Highlight text={item.text} positions={match.positions} />
                    </span>
                  </>
                ) : item.kind === "symbol" ? (
                  <>
                    {/* A glyph rather than a dot, so a function never reads as a
                        file at a glance; the dot's colour still names the owner. */}
                    <span
                      className="w-1.5 shrink-0 text-center text-[10px] italic"
                      style={{ color: directoryColor(item.file) }}
                    >
                      f
                    </span>
                    <span className="truncate text-bp-text">{item.label}</span>
                    <span className="ml-auto shrink-0 truncate text-[9px] text-bp-faint">
                      <Highlight text={item.text} positions={match.positions} />
                    </span>
                  </>
                ) : (
                  <>
                    <span className="w-1.5 shrink-0 text-center text-bp-accent">›</span>
                    <span className="truncate text-bp-text">
                      <Highlight text={item.text} positions={match.positions} />
                    </span>
                    {item.action.hint && (
                      <span className="ml-auto shrink-0 text-[9px] tracking-widest text-bp-faint uppercase">
                        {item.action.hint}
                      </span>
                    )}
                  </>
                )}
              </button>
            );
          })}
        </div>

        <div className="flex shrink-0 gap-4 border-t border-bp-rule px-3.5 py-1.5 text-[9px] tracking-widest text-bp-faint uppercase">
          <span>↑↓ navigate</span>
          <span>⏎ select</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
