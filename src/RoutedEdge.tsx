import { BaseEdge, type EdgeProps } from "@xyflow/react";

export type Waypoint = { x: number; y: number };

const round = (value: number) => Math.round(value * 10) / 10;

/**
 * How far a lane change may sit either side of the middle of a rank gap.
 *
 * Without this every edge crossing the same pair of ranks turns at exactly the
 * same x, because the turn was taken at the midpoint and midpoints depend only
 * on the ranks. Two such columns joined by two edges' horizontal runs close
 * into a rectangle, and an empty rectangle on this canvas reads as a node —
 * the one misreading a tool about import structure cannot afford.
 */
const LANE_SPREAD = 24;

/** Corner easing. Big enough to read as a wire, small enough to stay schematic. */
const CORNER_RADIUS = 5;

/** A stable offset per edge, so parallel routes fan out instead of stacking. */
function laneOffset(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  // Spread evenly across the band rather than clustering at its middle.
  return ((hash % 101) / 50 - 1) * LANE_SPREAD;
}

/**
 * Build a right-angled path that follows the lanes dagre reserved for this edge.
 *
 * Dagre lays out a long edge by inserting a dummy node into every rank it spans,
 * so each waypoint is a slot that no real node occupies. Travelling horizontally
 * *at* a waypoint's y and only changing lanes in the gaps *between* ranks keeps
 * the line clear of the boxes; drawing straight from handle to handle, as the
 * built-in edge types do, is what put lines through them.
 *
 * `seed` picks this edge's column within each gap. Any x strictly inside a gap
 * is free of boxes, so spreading the turns costs nothing and stops parallel
 * routes from closing into rectangles.
 */
export function routedPath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  waypoints: Waypoint[],
  seed = "",
): string {
  const points: Waypoint[] = [{ x: sourceX, y: sourceY }];
  const offset = laneOffset(seed);
  let lastRankX = sourceX;
  let lane = sourceY;

  const stepTo = (rankX: number, nextLane: number) => {
    // Change lanes inside the gap between the two ranks, which is empty by
    // construction. The offset is clamped to the room actually there, so a
    // narrow gap simply turns at its middle as it always did.
    const room = Math.max(0, Math.abs(rankX - lastRankX) / 2 - 8);
    const gapX = (lastRankX + rankX) / 2 + Math.max(-room, Math.min(room, offset));
    if (Math.abs(gapX - lastRankX) > 0.5) points.push({ x: gapX, y: lane });
    if (Math.abs(nextLane - lane) > 0.5) points.push({ x: gapX, y: nextLane });
    lastRankX = rankX;
    lane = nextLane;
  };

  for (const point of waypoints) stepTo(point.x, point.y);
  // Approach the target in its own lane so the arrowhead arrives horizontally.
  stepTo(targetX, targetY);
  points.push({ x: targetX, y: targetY });

  return roundCorners(points, CORNER_RADIUS);
}

/**
 * Emit a polyline with its corners eased.
 *
 * Fanning the turn columns apart stops most routes from closing into
 * rectangles, but two that happen to land near the same column still read as
 * one. A corner radius settles it for good: a rounded turn reads as a wire
 * changing direction, where a square one reads as the corner of a box. The
 * radius is small enough that the routing still looks drawn with a set square.
 */
function roundCorners(points: Waypoint[], radius: number): string {
  // Consecutive duplicates would give a zero-length segment to normalise by.
  const path = points.filter(
    (point, i) =>
      i === 0 || Math.abs(point.x - points[i - 1].x) > 0.5 || Math.abs(point.y - points[i - 1].y) > 0.5,
  );
  if (path.length === 0) return "";

  const segments = [`M${round(path[0].x)},${round(path[0].y)}`];
  for (let i = 1; i < path.length - 1; i++) {
    const previous = path[i - 1];
    const corner = path[i];
    const next = path[i + 1];
    const inLength = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const outLength = Math.hypot(next.x - corner.x, next.y - corner.y);
    // Never eat more than half of either arm, or short segments would invert.
    const r = Math.min(radius, inLength / 2, outLength / 2);
    if (r < 0.5) {
      segments.push(`L${round(corner.x)},${round(corner.y)}`);
      continue;
    }
    const from = {
      x: corner.x + ((previous.x - corner.x) / inLength) * r,
      y: corner.y + ((previous.y - corner.y) / inLength) * r,
    };
    const to = {
      x: corner.x + ((next.x - corner.x) / outLength) * r,
      y: corner.y + ((next.y - corner.y) / outLength) * r,
    };
    segments.push(
      `L${round(from.x)},${round(from.y)}`,
      `Q${round(corner.x)},${round(corner.y)} ${round(to.x)},${round(to.y)}`,
    );
  }
  const last = path[path.length - 1];
  segments.push(`L${round(last.x)},${round(last.y)}`);

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
      path={routedPath(sourceX, sourceY, targetX, targetY, waypoints, id)}
      markerEnd={markerEnd}
      style={style}
    />
  );
}
