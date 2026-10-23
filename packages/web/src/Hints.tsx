import type { Hint, Recommendation } from "@lgtm/core";
import { PROMPT_LEVEL, distinctRules, recommendationHelp, recommendationLabel, recommendationMarker, severityLabel, sortHints, topHints, plural } from "./viewmodel";

/** Every string here (rule, path, reason) comes from analysis of a session log and is rendered as a text node only. */

/** Recommendation as text: the words and the circle glyph differ per level, color is only a reinforcement. */
export function RecBadge({ rec }: { rec: Recommendation }) {
  return (
    <span className={`rec rec-${rec}`} title={recommendationHelp(rec)}>
      <span className="rec-glyph" aria-hidden="true">{recommendationMarker(rec)}</span> {recommendationLabel(rec)}
    </span>
  );
}

/** Rule names as small markers; `max` keeps a table cell short. */
export function RuleMarkers({ rules, max }: { rules: readonly string[]; max?: number }) {
  const shown = max === undefined ? rules : rules.slice(0, max);
  const rest = rules.length - shown.length;
  return (
    <>
      {shown.map((r) => (
        <span key={r} className="marker hint-marker mono">{r}</span>
      ))}
      {rest > 0 ? <span className="muted hint-more">+{rest}</span> : null}
    </>
  );
}

/** Review cell of the prompt table: recommendation plus the distinct rule names. */
export function ReviewCell({ rec, hints }: { rec: Recommendation; hints: readonly Hint[] }) {
  return (
    <>
      <RecBadge rec={rec} />
      {hints.length > 0 ? (
        <div className="review-rules">
          <RuleMarkers rules={distinctRules(hints)} max={3} />
        </div>
      ) : null}
    </>
  );
}

function HintItem({ h, pathLabel }: { h: Hint; pathLabel?: (p: string) => string }) {
  return (
    <li className="hint">
      <span className={`sev sev-${h.severity}`}>{severityLabel(h.severity)}</span>
      <span className="mono hint-rule">{h.rule}</span>
      {h.path === null ? <span className="muted">{PROMPT_LEVEL}</span> : <span className="mono hint-path">{pathLabel ? pathLabel(h.path) : h.path}</span>}
      <span className="hint-reason">{h.reason}</span>
    </li>
  );
}

/** Full list of hints (severity, rule, path, reason), highest severity first. */
export function HintList({ hints, pathLabel }: { hints: readonly Hint[]; pathLabel?: (p: string) => string }) {
  if (hints.length === 0) return <p className="muted">No review hints.</p>;
  return (
    <ul className="hints" aria-label={`Review hints (${hints.length})`}>
      {sortHints(hints).map((h, i) => (
        <HintItem key={i} h={h} {...(pathLabel ? { pathLabel } : {})} />
      ))}
    </ul>
  );
}

/** "Where to look" block of the Steps view: recommendation and the top hints. */
export function WhereToLook({ rec, hints, pathLabel }: { rec: Recommendation; hints: readonly Hint[]; pathLabel?: (p: string) => string }) {
  const { shown, hidden } = topHints(hints);
  return (
    <section className="where" aria-labelledby="where-title">
      <h3 id="where-title" className="where-title">Where to look</h3>
      <p className="where-rec">
        Review: <RecBadge rec={rec} />
      </p>
      {shown.length === 0 ? (
        <p className="muted">No review hints for this prompt.</p>
      ) : (
        <ul className="hints" aria-label={`Top review hints (${shown.length} of ${hints.length})`}>
          {shown.map((h, i) => (
            <HintItem key={i} h={h} {...(pathLabel ? { pathLabel } : {})} />
          ))}
        </ul>
      )}
      {hidden > 0 ? <p className="muted">{plural(hidden, "more hint")} in the session table.</p> : null}
    </section>
  );
}
