// Tiny SVG area/line chart from a number series (enowx-derived, themed via
// currentColor + CSS var so it follows the active scheme).
export function Sparkline({ values, height = 36 }: { values: number[]; height?: number }) {
  if (values.length === 0) {
    return <div className="py-2 text-center text-[11px] text-muted-foreground">no data yet</div>;
  }
  const w = 100;
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => `${i * step},${height - (v / max) * height}`);
  const line = pts.join(" ");
  const area = `0,${height} ${line} ${w},${height}`;

  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="h-9 w-full">
      <polygon points={area} fill="currentColor" opacity="0.18" />
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
