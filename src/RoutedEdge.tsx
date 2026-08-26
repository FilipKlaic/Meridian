import { BaseEdge, type EdgeProps } from "@xyflow/react";

export type Waypoint = { x: number; y: number };

const round = (value: number) => Math.round(value * 10) / 10;

/**
 * Build a right-angled path that follows the lanes dagre reserved for this edge.
 *
 * Dagre lays out a long edge by inserting a dummy node into every rank it spans,
 * so each waypoint is a slot that no real node occupies. Travelling horizontally
 * *at* a waypoint's y and only changing lanes in the gaps *between* ranks keeps
 * the line clear of the boxes; drawing straight from handle to handle, as the
 * built-in edge types do, is what put lines through them.
 */
export function routedPath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  waypoints: Waypoint[],
): string {
  const segments: string[] = [`M${round(sourceX)},${round(sourceY)}`];
  let lastRankX = sourceX;
  let lane = sourceY;

  const stepTo = (rankX: number, nextLane: number) => {
    // Change lanes halfway between the two ranks, which is empty by construction.
    const gapX = (lastRankX + rankX) / 2;
    if (Math.abs(gapX - lastRankX) > 0.5) segments.push(`L${round(gapX)},${round(lane)}`);
    if (Math.abs(nextLane - lane) > 0.5) segments.push(`L${round(gapX)},${round(nextLane)}`);
    lastRankX = rankX;
    lane = nextLane;
  };

  for (const point of waypoints) stepTo(point.x, point.y);
  // Approach the target in its own lane so the arrowhead arrives horizontally.
  stepTo(targetX, targetY);
  segments.push(`L${round(targetX)},${round(targetY)}`);

  return segments.join(" ");
}

/** An edge drawn along the route dagre already worked out for it. */
export default function RoutedEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  style,
  data,
}: EdgeProps) {
  const waypoints = (data?.waypoints as Waypoint[] | undefined) ?? [];
  return (
    <BaseEdge
      id={id}
      path={routedPath(sourceX, sourceY, targetX, targetY, waypoints)}
      markerEnd={markerEnd}
      style={style}
    />
  );
}
