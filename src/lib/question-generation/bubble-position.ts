export function bubblePosition(
  frame: { width: number; height: number },
  anchor: { left: number; right: number; top: number; bottom: number },
  requestedHeight: number,
  obstacles: Array<{ left: number; right: number; top: number; bottom: number }> = [],
) {
  const margin = Math.min(8, frame.width / 8, frame.height / 8);
  const gap = 8;
  const width = Math.max(0, Math.min(320, frame.width - margin * 2));
  const below = Math.max(0, frame.height - margin - Math.max(margin, anchor.bottom + gap));
  const above = Math.max(0, Math.min(frame.height - margin, anchor.top - gap) - margin);
  const side = below >= requestedHeight || below >= above ? "below" : "above";
  const available = side === "below" ? below : above;
  const compact = available < Math.min(40, frame.height - margin * 2);
  const maxHeight = compact ? frame.height - margin * 2 : available;
  const height = Math.min(requestedHeight, maxHeight);
  const left = Math.max(margin, Math.min(
    (anchor.left + anchor.right - width) / 2, frame.width - width - margin,
  ));
  const preferredTop = compact ? margin : side === "below" ? Math.max(margin, anchor.bottom + gap) :
    Math.min(frame.height - margin, anchor.top - gap) - height;
  const maxTop = Math.max(margin, frame.height - margin - height);
  const candidates = new Set([preferredTop, margin, maxTop,
    Math.max(margin, Math.min(maxTop, anchor.top - gap - height)),
    Math.max(margin, Math.min(maxTop, anchor.bottom + gap))]);
  for (const obstacle of obstacles) {
    candidates.add(Math.max(margin, Math.min(maxTop, obstacle.top - gap - height)));
    candidates.add(Math.max(margin, Math.min(maxTop, obstacle.bottom + gap)));
  }
  const top = [...candidates].reduce((best, candidate) => {
    const overlap = obstacles.reduce((total, obstacle) => {
      const widthOverlap = Math.max(0, Math.min(left + width, obstacle.right) - Math.max(left, obstacle.left));
      const heightOverlap = Math.max(0, Math.min(candidate + height, obstacle.bottom) - Math.max(candidate, obstacle.top));
      return total + widthOverlap * heightOverlap;
    }, 0);
    const score = overlap * 1000 + Math.abs(candidate - preferredTop);
    const bestOverlap = obstacles.reduce((total, obstacle) => {
      const widthOverlap = Math.max(0, Math.min(left + width, obstacle.right) - Math.max(left, obstacle.left));
      const heightOverlap = Math.max(0, Math.min(best + height, obstacle.bottom) - Math.max(best, obstacle.top));
      return total + widthOverlap * heightOverlap;
    }, 0);
    const bestScore = bestOverlap * 1000 + Math.abs(best - preferredTop);
    return score < bestScore ? candidate : best;
  }, preferredTop);
  return { left, top: Math.max(margin, Math.min(maxTop, top)), width, maxHeight: height, side };
}
