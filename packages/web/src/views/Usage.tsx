import { useId, useRef, useState } from "react";
import { fmtCost, get } from "../api";
import { useAsync, ErrorBox } from "../components";
import { useT } from "../i18n-react";

/**
 * Calendar heatmap windows, in weeks. The grid used to be fixed at 26 weeks:
 * long enough that a busy month sat in the corner of a wall of grey, and short
 * enough that the whole history could not be seen at all. Cells are one day,
 * columns are Monday-start weeks.
 */
const RANGES = [4, 12, 26, 52] as const;
type Range = (typeof RANGES)[number];
const WEEKS = RANGES[2];
const CELL = 14; // px, matches --heat-cell in style.css
const GAP = 3;
/** Readout width, so it can be centred before it is drawn and measured. */
const TIP_WIDTH = 168;
/** Room for a month label: a month only gets one if it clears this many columns. */
const MONTH_LABEL_MIN_COLUMNS = 3;

type Metric = "cost" | "tokens";

/** The day a readout is pinned to, and where that readout is drawn. */
interface HoverCell {
  key: string;
  bucket: DayBucket | undefined;
  left: number;
  top: number;
}

interface DayBucket {
  date: string;
  cost: number;
  requests: number;
  tokens: number;
}

/**
 * The day grid ends on the week containing `today` and starts `weeks - 1`
 * weeks earlier, padded to whole Monday-start weeks so every column has
 * seven rows. Days without a run are zeroes, not gaps.
 */
function heatWeeks(today: Date, weeks: number = WEEKS): Date[][] {
  const day = 24 * 60 * 60 * 1000;
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const end = new Date(midnight.getTime() + (7 - ((midnight.getDay() + 6) % 7)) * day); // coming Sunday
  const start = new Date(end.getTime() - (weeks * 7 - 1) * day); // a Monday
  const out: Date[][] = [];
  for (let w = 0; w < weeks; w++) {
    const column: Date[] = [];
    for (let d = 0; d < 7; d++) column.push(new Date(start.getTime() + (w * 7 + d) * day));
    out.push(column);
  }
  return out;
}

/** YYYY-MM-DD in the host's own time zone, matching the server's grouping. */
function localDayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * An absolute date for the hover readout: `2026-10-31` plus a weekday.
 *
 * Built from the same `YYYY-MM-DD` key the server groups by, then formatted by
 * the host's own locale — so the weekday name matches the rest of the OS the
 * user reads, without asking the date parser to reinterpret the key (which
 * would shift it a day in a negative-offset time zone).
 */
function dayLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  if (!y || !m || !d) return key;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    weekday: "short",
  });
}

/** Month label for the first column of each month, thinned so labels of
 *  short months do not pile up on each other. */
function monthTicks(weeks: Date[][], monthLabel: (n: number) => string): Array<{ index: number; label: string }> {
  const starts: Array<{ index: number; label: string }> = [];
  let last = -1;
  weeks.forEach((column, i) => {
    if (column[0].getMonth() !== last) {
      starts.push({ index: i, label: monthLabel(column[0].getMonth() + 1) });
      last = column[0].getMonth();
    }
  });
  return starts.filter((tick, i) => i === 0 || tick.index - starts[i - 1].index >= MONTH_LABEL_MIN_COLUMNS);
}

export function UsageView() {
  const t = useT();
  const { data, error } = useAsync<any>(() => get("/api/usage"), []);
  const [metric, setMetric] = useState<Metric>("cost");
  if (error) return <ErrorBox message={error} />;
  if (!data) return <div className="muted">{t("common.loading")}</div>;

  return (
    <div>
      <h1>{t("usage.title")}</h1>
      <p className="sub">{t("usage.subtitle")}</p>

      <div className="grid">
        <div className="stat"><div className="num">{data.runs}</div><div className="lbl">{t("usage.stat.runs")}</div></div>
        <div className="stat"><div className="num">{data.inputTokens.toLocaleString()}</div><div className="lbl">{t("usage.stat.inputTokens")}</div></div>
        <div className="stat"><div className="num">{data.outputTokens.toLocaleString()}</div><div className="lbl">{t("usage.stat.outputTokens")}</div></div>
        <div className="stat"><div className="num">{data.modelRequests}</div><div className="lbl">{t("usage.stat.modelRequests")}</div></div>
        <div className="stat"><div className="num">{fmtCost(data.estimatedCost)}</div><div className="lbl">{t("usage.stat.estimatedCost")}</div></div>
      </div>

      <Heatmap history={data.history ?? []} metric={metric} onMetric={setMetric} />

      <h2>{t("usage.byModel")}</h2>
      <div className="card">
        {Object.entries(data.byModel ?? {}).length === 0 && <div className="muted">{t("usage.noModel")}</div>}
        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">{t("usage.col.model")}</th><th scope="col">{t("usage.col.requests")}</th><th scope="col">{t("usage.col.input")}</th>
              <th scope="col">{t("usage.col.output")}</th><th scope="col">{t("usage.col.cached")}</th><th scope="col">{t("usage.col.cost")}</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(data.byModel ?? {}).map(([name, m]: [string, any]) => (
              <tr key={name}>
                <td className="mono">{name}</td>
                <td>{m.requests}</td>
                <td>{m.inputTokens}</td>
                <td>{m.outputTokens}</td>
                <td>{m.cachedTokens}</td>
                <td>${m.cost.toFixed(6)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      <h2>{t("usage.byProvider")}</h2>
      <div className="card">
        {Object.entries(data.byProvider ?? {}).length === 0 && <div className="muted">{t("usage.noProvider")}</div>}
        <div className="table-wrap">
        <table>
          <thead><tr><th scope="col">{t("usage.col.provider")}</th><th scope="col">{t("usage.col.requests")}</th><th scope="col">{t("usage.col.cost")}</th></tr></thead>
          <tbody>
            {Object.entries(data.byProvider ?? {}).map(([id, p]: [string, any]) => (
              <tr key={id}>
                <td className="mono">{id}</td>
                <td>{p.requests}</td>
                <td>{fmtCost(p.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}

/**
 * Cost/token activity as a calendar heatmap: one cell per day over the last
 * half year, shaded by that day's value, so *when* work happened is
 * readable at a glance — the shape a bar chart of the same days cannot
 * show once the window is longer than a couple of weeks.
 */
function Heatmap({ history, metric, onMetric }: { history: DayBucket[]; metric: Metric; onMetric: (m: Metric) => void }) {
  const t = useT();
  const [weeks_count, setWeeks] = useState<Range>(WEEKS);
  const weeks = heatWeeks(new Date(), weeks_count);
  const byDate = new Map(history.map((h) => [h.date, h]));
  // The day under the pointer, or null. Held as state (not a CSS tooltip) so
  // the readout can carry every fact about the day at once — date, cost,
  // tokens, requests — instead of whichever one the current metric shows.
  const [hover, setHover] = useState<HoverCell | null>(null);
  const rangeLabelId = useId();
  const gridRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);

  /**
   * Where the readout goes for a cell: above it when there is room, else
   * below; clamped to the card so a cell in the first or last column does not
   * push the readout out of the panel.
   */
  const anchor = (cell: HTMLElement, key: string, bucket: DayBucket | undefined): HoverCell => {
    const grid = gridRef.current;
    if (!grid) return { key, bucket, left: 0, top: 0 };
    const cellBox = cell.getBoundingClientRect();
    const gridBox = grid.getBoundingClientRect();
    const hostBox = (grid.closest(".heat-card") ?? grid).getBoundingClientRect();
    // The readout's real height, once it is drawn; the first hover of a session
    // falls back to an estimate, which a fixed-size box makes close enough.
    const tipHeight = tipRef.current?.offsetHeight ?? 92;
    // Centre the readout over the cell, then keep it inside the card: the first
    // and last columns otherwise stick out of the panel. Measured in the grid's
    // coordinates, past the grid's own box when the readout must sit above it.
    const centred = cellBox.left - gridBox.left - (TIP_WIDTH - CELL) / 2;
    const left = Math.max(hostBox.left - gridBox.left, Math.min(centred, hostBox.right - gridBox.left - TIP_WIDTH));
    const above = cellBox.top - gridBox.top - tipHeight - 6;
    const top = above >= 0 ? above : cellBox.bottom - gridBox.top + 6;
    return { key, bucket, left: Math.round(left), top: Math.round(top) };
  };

  /** The readout as one sentence, for readers who never hover (screen readers). */
  const readout = (key: string, bucket: DayBucket | undefined) =>
    `${dayLabel(key)} · ${t("usage.cellTip", {
      value: `${fmtCost(bucket?.cost ?? 0)}`,
      tokens: (bucket?.tokens ?? 0).toLocaleString(),
      requests: bucket?.requests ?? 0,
    })}`;
  const valueOf = (h: DayBucket | undefined) => (h ? (metric === "cost" ? h.cost : h.tokens) : 0);

  // Value levels are quantiles of the days that saw work, so one expensive
  // day cannot wash out the rest of the window.
  const active = history.map(valueOf).filter((v) => v > 0).sort((a, b) => a - b);
  const levelOf = (v: number) => {
    if (v <= 0 || active.length === 0) return 0;
    const rank = active.filter((x) => x <= v).length / active.length;
    return Math.min(4, Math.max(1, Math.ceil(rank * 4)));
  };

  const inWindow = weeks.flat().filter((d) => byDate.has(localDayKey(d)));
  const total = inWindow.reduce((sum, d) => sum + valueOf(byDate.get(localDayKey(d))), 0);
  const best = inWindow.reduce((max, d) => Math.max(max, valueOf(byDate.get(localDayKey(d)))), 0);
  const unit = metric === "cost" ? t("usage.unit.cost") : t("usage.unit.tokens");
  const show = (v: number) => (metric === "cost" ? fmtCost(v) : v.toLocaleString());

  return (
    <>
      <div className="row heat-head">
        <h2>{t("usage.costHistory")}</h2>
      </div>
      {/* Every control the history has — which metric it shades by and which
          window it covers — in one toolbar under the heading. The window used
          to sit in the legend line as a second, unlabelled segment, at the far
          right of a row that also carried the totals and the colour key. */}
      <div className="row usage-toolbar" role="group" aria-label={t("usage.controls.label")}>
        <span className="usage-control">
          <span className="usage-control-label">{t("usage.metric.label")}</span>
          {/* Segmented control: one grey track, the chosen metric lifted onto
              a white pill. */}
          <span className="segmented">
            <button aria-pressed={metric === "cost"} onClick={() => onMetric("cost")}>{t("usage.metric.cost")}</button>
            <button aria-pressed={metric === "tokens"} onClick={() => onMetric("tokens")}>{t("usage.metric.tokens")}</button>
          </span>
        </span>
        <span className="usage-control">
          <span className="usage-control-label">{t("usage.range.label")}</span>
          {/* The window is a choice: 4 weeks answers "what have I done lately",
              52 answers "what does a year of this look like". */}
          <span className="segmented heat-range" role="group" aria-labelledby={rangeLabelId}>
            <span id={rangeLabelId} className="sr-only">{t("usage.range.label")}</span>
            {RANGES.map((n) => (
              <button key={n} aria-pressed={weeks_count === n} onClick={() => setWeeks(n)}>
                {t("usage.range.weeks", { n })}
              </button>
            ))}
          </span>
        </span>
      </div>
      {/* The card is the positioning context for the readout: the grid itself
          scrolls horizontally, and anything drawn inside a scroller is cut off
          at its edge. */}
      <div className="card heat-card">
        <div className="heat-legend">
          <span className="muted">
            {t("usage.summary", { total: show(total), unit, best: show(best), weeks: weeks_count })}
          </span>
          <span className="right muted">
            {t("usage.legend.less")} <i className="heat-cell" /> <i className="heat-cell l1" /> <i className="heat-cell l2" />{" "}
            <i className="heat-cell l3" /> <i className="heat-cell l4" /> {t("usage.legend.more")}
          </span>
        </div>
        <div className="heat-scroll">
          <div className="heat-months" style={{ gridTemplateColumns: `repeat(${weeks.length}, ${CELL}px)`, gap: GAP }}>
            {monthTicks(weeks, (n) => t("usage.month", { n })).map((tick) => (
              <span key={tick.index} style={{ gridColumn: tick.index + 1 }}>{tick.label}</span>
            ))}
          </div>
          <div ref={gridRef} className="heat-grid" style={{ gridTemplateColumns: `repeat(${weeks.length}, ${CELL}px)`, gap: GAP }}>
            {weeks.flat().map((d) => {
              const key = localDayKey(d);
              const bucket = byDate.get(key);
              const value = valueOf(bucket);
              const cell = hover && hover.key === key ? hover : null;
              return (
                <div
                  key={key}
                  className={`heat-cell l${levelOf(value)}${cell ? " hover" : ""}`}
                  role="img"
                  aria-label={readout(key, bucket)}
                  onMouseEnter={(event) => setHover(anchor(event.currentTarget, key, bucket))}
                  onMouseMove={(event) => setHover(anchor(event.currentTarget, key, bucket))}
                  onMouseLeave={() => setHover(null)}
                  onFocus={(event) => setHover(anchor(event.currentTarget, key, bucket))}
                  onBlur={() => setHover(null)}
                  tabIndex={0}
                />
              );
            })}
          </div>
        </div>
        {/* One floating readout for the whole grid, drawn above everything and
            kept inside the card. Doing it once, positioned from the hovered
            cell's own rectangle, beats 364 absolutely-positioned tooltips and
            cannot be clipped by the grid's scroll box. */}
        {hover && (
          <div ref={tipRef} className="heat-tip" style={{ left: hover.left, top: hover.top }} role="status">
            <div className="heat-tip-date">{dayLabel(hover.key)}</div>
            <div className="heat-tip-row">
              <span>{t("usage.cellTip.cost")}</span>
              <b>{fmtCost(hover.bucket?.cost ?? 0)}</b>
            </div>
            <div className="heat-tip-row">
              <span>{t("usage.cellTip.tokens")}</span>
              <b>{(hover.bucket?.tokens ?? 0).toLocaleString()}</b>
            </div>
            <div className="heat-tip-row">
              <span>{t("usage.cellTip.requests")}</span>
              <b>{(hover.bucket?.requests ?? 0).toLocaleString()}</b>
            </div>
          </div>
        )}
        {total === 0 && <div className="muted">{t("usage.empty")}</div>}
      </div>
    </>
  );
}
