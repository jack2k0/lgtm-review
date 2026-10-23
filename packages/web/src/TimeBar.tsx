import type { TimeSplit } from "@lgtm/core";
import { timeBarText, timeSegments } from "./viewmodel";

export function TimeBar({ split, headline }: { split: TimeSplit; headline: string }) {
  const segs = timeSegments(split);
  const text = timeBarText(split);
  return (
    <div className="timecell">
      <div className="timebar" role="img" aria-label={`Approximate time split: ${text}`} title={text}>
        {segs.map((s) => (
          <span key={s.phase} className={`seg seg-${s.phase}`} style={{ width: `${s.pct}%` }} />
        ))}
      </div>
      <div className="headline">{headline}</div>
    </div>
  );
}

export function TimeLegend() {
  return (
    <p className="legend" aria-label="Time split legend">
      <span className="legend-item"><span className="swatch seg-read" aria-hidden="true" />Read</span>
      <span className="legend-item"><span className="swatch seg-write" aria-hidden="true" />Write</span>
      <span className="legend-item"><span className="swatch seg-check" aria-hidden="true" />Check</span>
      <span className="legend-item"><span className="swatch seg-fix" aria-hidden="true" />Fix</span>
      <span className="muted">Times are approximate (approx.); hover or read the bar label for durations.</span>
    </p>
  );
}
