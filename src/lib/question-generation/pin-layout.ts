export type PinTarget = {
  id: string;
  questionId?: string;
  slot: number;
  x: number;
  y: number;
};

export function layoutQuestionPins(
  frame: { width: number; height: number },
  pins: PinTarget[],
) {
  if (frame.width <= 0 || frame.height <= 0) return [];
  const radius = 19;
  const minimumDistance = radius * 2 + 6;
  const marginX = Math.min(radius, frame.width / 2);
  const marginY = Math.min(radius, frame.height / 2);
  const placed: Array<PinTarget & { left: number; top: number; originalX: number; originalY: number }> = [];

  for (const pin of [...pins].sort((a, b) => a.slot - b.slot || a.id.localeCompare(b.id))) {
    const originalX = pin.x * frame.width;
    const originalY = pin.y * frame.height;
    const candidates: Array<{ left: number; top: number; distance: number }> = [];
    const maxRadius = Math.min(Math.hypot(frame.width, frame.height),
      minimumDistance * (pins.length + 1) * 2);
    const seen = new Set<string>();
    for (let radiusFromOrigin = 0; radiusFromOrigin <= maxRadius; radiusFromOrigin += 8) {
      const steps = radiusFromOrigin === 0 ? 1 : 24;
      for (let step = 0; step < steps; step++) {
        const angle = (step / steps) * Math.PI * 2;
        const left = Math.max(marginX, Math.min(frame.width - marginX,
          originalX + Math.cos(angle) * radiusFromOrigin));
        const top = Math.max(marginY, Math.min(frame.height - marginY,
          originalY + Math.sin(angle) * radiusFromOrigin));
        const distance = Math.hypot(left - originalX, top - originalY);
        const key = `${left.toFixed(1)}:${top.toFixed(1)}`;
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push({ left, top, distance });
        }
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);

    let best = candidates[0];
    let bestScore = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const collision = placed.reduce((total, other) => {
        const distance = Math.hypot(candidate.left - other.left, candidate.top - other.top);
        return total + (distance < minimumDistance ? (minimumDistance - distance + 1) ** 2 : 0);
      }, 0);
      if (collision === 0) {
        best = candidate;
        break;
      }
      const score = candidate.distance + collision * 100;
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    placed.push({ ...pin, left: best.left, top: best.top, originalX, originalY });
  }

  return placed;
}
