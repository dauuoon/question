export function bubblePosition(
  frame: { width: number; height: number },
  anchor: { left: number; right: number; top: number; bottom: number },
  requestedHeight: number,
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
  const top = compact ? margin : side === "below" ? Math.max(margin, anchor.bottom + gap) :
    Math.min(frame.height - margin, anchor.top - gap) - height;
  return { left, top, width, maxHeight: height, side };
}
