export type FuzzyMatch = {
  score: number;
  /** Indices in the target that the query matched, for highlighting. */
  positions: number[];
};

const SEPARATORS = new Set(["/", ".", "-", "_", " "]);

function isBoundary(target: string, index: number): boolean {
  if (index === 0) return true;
  const previous = target[index - 1];
  if (SEPARATORS.has(previous)) return true;
  // camelCase hump: a lowercase letter followed by an uppercase one.
  return previous === previous.toLowerCase() && target[index] !== target[index].toLowerCase();
}

/**
 * Subsequence match with positional bonuses, in the spirit of an editor's
 * file finder: `apptsx` finds `src/App.tsx`, and matches that land on word
 * boundaries or run consecutively outrank matches scattered through the string.
 *
 * Returns null when the query is not a subsequence of the target at all.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return { score: 0, positions: [] };

  const haystack = target.toLowerCase();
  const positions: number[] = [];

  let score = 0;
  let cursor = 0;
  let previousIndex = -1;

  for (const character of needle) {
    const found = haystack.indexOf(character, cursor);
    if (found === -1) return null;

    if (found === previousIndex + 1) score += 8; // consecutive run
    if (isBoundary(target, found)) score += 6; // start of a word or segment
    // Prefer matches that start early, and don't wander.
    score -= Math.min(found - cursor, 12);

    positions.push(found);
    previousIndex = found;
    cursor = found + 1;
  }

  // A literal substring is almost always what the user meant.
  if (haystack.includes(needle)) score += 24;
  // Matching inside the file name beats matching in the directory path.
  const slash = target.lastIndexOf("/");
  if (positions[0] > slash) score += 10;
  // Nudge shorter targets ahead when scores are otherwise close.
  score -= target.length * 0.08;

  return { score, positions };
}

export type Ranked<T> = { item: T; match: FuzzyMatch };

/** Filter and rank a list, best first. An empty query keeps the original order. */
export function rank<T>(query: string, items: T[], key: (item: T) => string): Ranked<T>[] {
  if (!query.trim()) return items.map((item) => ({ item, match: { score: 0, positions: [] } }));

  const ranked: Ranked<T>[] = [];
  for (const item of items) {
    const match = fuzzyMatch(query, key(item));
    if (match) ranked.push({ item, match });
  }
  return ranked.sort((a, b) => b.match.score - a.match.score);
}
