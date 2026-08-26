/** Renders text with the fuzzy-matched characters picked out. */
export default function Highlight({ text, positions }: { text: string; positions: number[] }) {
  if (positions.length === 0) return <>{text}</>;

  const marked = new Set(positions);
  const runs: { text: string; hit: boolean }[] = [];

  for (let i = 0; i < text.length; i++) {
    const hit = marked.has(i);
    const last = runs[runs.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else runs.push({ text: text[i], hit });
  }

  return (
    <>
      {runs.map((run, i) =>
        run.hit ? (
          <span key={i} className="text-bp-accent">
            {run.text}
          </span>
        ) : (
          <span key={i}>{run.text}</span>
        ),
      )}
    </>
  );
}
