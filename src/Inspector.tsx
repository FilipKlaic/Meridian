import { useMemo, useState } from "react";

import Highlight from "./Highlight";
import { rank } from "./fuzzy";
import type { FileEntry, GraphIndex, SymbolEntry } from "./graphIndex";
import { directoryColor } from "./layout";

function Dot({ id }: { id: string }) {
  return <span className="size-1.5 shrink-0" style={{ background: directoryColor(id) }} />;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-1.5 text-[9px] tracking-[0.18em] text-bp-faint uppercase">
      {children}
    </div>
  );
}

/** A file row in the "imports" / "imported by" lists. */
function RelatedRow({
  entry,
  onSelect,
}: {
  entry: FileEntry;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      onClick={() => onSelect(entry.id)}
      title={entry.id}
      className="flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] text-bp-muted transition-colors hover:bg-bp-hover hover:text-bp-text"
    >
      <Dot id={entry.id} />
      <span className="truncate">{entry.label}</span>
      <span className="ml-auto shrink-0 truncate text-[9px] text-bp-faint">
        {entry.directory || "/"}
      </span>
    </button>
  );
}

/**
 * A declaration in the selected file. Clicking one is the shortest route to the
 * question the call graph exists to answer — what does this one function touch —
 * so the counts either side of it are shown up front: callers, then callees.
 */
function SymbolRow({
  symbol,
  active,
  onSelect,
}: {
  symbol: SymbolEntry;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      onClick={() => onSelect(symbol.id)}
      title={`${symbol.id} — ${symbol.calledBy.length} in, ${symbol.calls.length} out`}
      className={`flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] transition-colors hover:bg-bp-hover ${
        active ? "bg-bp-hover text-bp-accent" : "text-bp-muted hover:text-bp-text"
      }`}
    >
      <span className="w-1.5 shrink-0 text-center text-[10px] italic text-bp-faint">f</span>
      <span className="truncate">{symbol.label}</span>
      {symbol.exported && (
        <span className="shrink-0 text-[8px] tracking-widest text-bp-accent">EX</span>
      )}
      <span className="tabular ml-auto shrink-0 text-[9px] text-bp-faint">
        {symbol.calledBy.length}/{symbol.calls.length}
      </span>
    </button>
  );
}

export default function Inspector({
  index,
  selectedId,
  anchoredSymbol,
  onSelect,
  onSelectSymbol,
}: {
  index: GraphIndex;
  selectedId: string | null;
  /** Id of the symbol the call graph is anchored on, if it is anchored on one. */
  anchoredSymbol: string | null;
  onSelect: (id: string) => void;
  onSelectSymbol: (id: string) => void;
}) {
  const [query, setQuery] = useState("");

  const results = useMemo(
    () => rank(query, index.entries, (entry) => entry.id),
    [query, index.entries],
  );

  // With no query, keep the directory grouping; once filtering, a flat ranked
  // list is what the user is actually reading.
  const filtering = query.trim().length > 0;
  const selected = selectedId ? (index.byId.get(selectedId) ?? null) : null;
  const declared = selectedId ? (index.symbolsByFile.get(selectedId) ?? []) : [];

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-bp-rule bg-bp-void">
      <div className="border-b border-bp-rule p-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter files…"
          spellCheck={false}
          className="w-full border border-bp-rule bg-bp-canvas px-2 py-1.5 font-mono text-[11px] text-bp-text placeholder:text-bp-faint focus:border-bp-accent focus:outline-none"
        />
      </div>

      <div className="bp-scroll min-h-0 flex-1 overflow-y-auto py-1">
        {results.length === 0 && (
          <p className="px-3 py-4 text-[11px] text-bp-faint">No files match.</p>
        )}

        {filtering
          ? results.map(({ item, match }) => (
              <button
                key={item.id}
                onClick={() => onSelect(item.id)}
                title={item.id}
                className={`flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] transition-colors hover:bg-bp-hover ${
                  item.id === selectedId ? "bg-bp-hover text-bp-accent" : "text-bp-text"
                }`}
              >
                <Dot id={item.id} />
                <span className="truncate">
                  <Highlight text={item.id} positions={match.positions} />
                </span>
              </button>
            ))
          : index.directories.map((directory) => (
              <div key={directory.name || "/"}>
                <SectionTitle>{directory.name || "/"}</SectionTitle>
                {directory.files.map((entry) => (
                  <button
                    key={entry.id}
                    onClick={() => onSelect(entry.id)}
                    title={entry.id}
                    className={`flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] transition-colors hover:bg-bp-hover ${
                      entry.id === selectedId ? "bg-bp-hover text-bp-accent" : "text-bp-text"
                    }`}
                  >
                    <Dot id={entry.id} />
                    <span className="truncate">{entry.label}</span>
                    <span className="tabular ml-auto shrink-0 text-[9px] text-bp-faint">
                      {entry.importedBy.length}/{entry.imports.length}
                    </span>
                  </button>
                ))}
              </div>
            ))}
      </div>

      {selected && (
        <div className="bp-scroll max-h-72 shrink-0 overflow-y-auto border-t border-bp-rule bg-bp-canvas">
          <div className="px-3 pt-2.5 pb-1">
            <p className="truncate text-[11px] text-bp-text" title={selected.path}>
              {selected.label}
            </p>
            <p className="truncate text-[9px] text-bp-faint" title={selected.id}>
              {selected.directory || "/"}
            </p>
          </div>

          <SectionTitle>Declares · {declared.length}</SectionTitle>
          {declared.length === 0 ? (
            <p className="px-3 pb-1 text-[10px] text-bp-faint">
              {index.symbols.length === 0 ? "Rescan to chart functions." : "Nothing."}
            </p>
          ) : (
            declared.map((symbol) => (
              <SymbolRow
                key={symbol.id}
                symbol={symbol}
                active={symbol.id === anchoredSymbol}
                onSelect={onSelectSymbol}
              />
            ))
          )}

          <SectionTitle>Imports · {selected.imports.length}</SectionTitle>
          {selected.imports.length === 0 ? (
            <p className="px-3 pb-1 text-[10px] text-bp-faint">Nothing.</p>
          ) : (
            selected.imports.map((id) => {
              const entry = index.byId.get(id);
              return entry ? <RelatedRow key={id} entry={entry} onSelect={onSelect} /> : null;
            })
          )}

          <SectionTitle>Imported by · {selected.importedBy.length}</SectionTitle>
          {selected.importedBy.length === 0 ? (
            <p className="px-3 pb-2 text-[10px] text-bp-faint">Nothing.</p>
          ) : (
            selected.importedBy.map((id) => {
              const entry = index.byId.get(id);
              return entry ? <RelatedRow key={id} entry={entry} onSelect={onSelect} /> : null;
            })
          )}
        </div>
      )}
    </aside>
  );
}
