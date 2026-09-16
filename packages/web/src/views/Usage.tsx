import { useState } from "react";
import { get } from "../api";
import { useAsync, ErrorBox } from "../components";

/** Calendar heatmap window: half a year of weeks, like the contribution
 *  grid this follows. Cells are one day, columns are Monday-start weeks. */
const WEEKS = 26;
const CELL = 14; // px, matches --heat-cell in style.css
const GAP = 3;
/** Room for a "10月" label: a month only gets one if it clears this many columns. */
const MONTH_LABEL_MIN_COLUMNS = 3;

type Metric = "cost" | "tokens";

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
function heatWeeks(today: Date, weeks = WEEKS): Date[][] {
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

/** Month label for the first column of each month, thinned so labels of
 *  short months do not pile up on each other. */
function monthTicks(weeks: Date[][]): Array<{ index: number; label: string }> {
  const starts: Array<{ index: number; label: string }> = [];
  let last = -1;
  weeks.forEach((column, i) => {
    if (column[0].getMonth() !== last) {
      starts.push({ index: i, label: `${column[0].getMonth() + 1}月` });
      last = column[0].getMonth();
    }
  });
  return starts.filter((tick, i) => i === 0 || tick.index - starts[i - 1].index >= MONTH_LABEL_MIN_COLUMNS);
}

function formatCost(v: number): string {
  return `$${v >= 1 ? v.toFixed(2) : v.toFixed(4)}`;
}

export function UsageView() {
  const { data, error } = useAsync<any>(() => get("/api/usage"), []);
  const [metric, setMetric] = useState<Metric>("cost");
  if (error) return <ErrorBox message={error} />;
  if (!data) return <div className="muted">Loading…</div>;

  return (
    <div>
      <h1>Usage & Cost</h1>
      <p className="sub">Unified tracking across providers and models.</p>

      <div className="grid">
        <div className="stat"><div className="num">{data.runs}</div><div className="lbl">runs</div></div>
        <div className="stat"><div className="num">{data.inputTokens.toLocaleString()}</div><div className="lbl">input tokens</div></div>
        <div className="stat"><div className="num">{data.outputTokens.toLocaleString()}</div><div className="lbl">output tokens</div></div>
        <div className="stat"><div className="num">{data.modelRequests}</div><div className="lbl">model requests</div></div>
        <div className="stat"><div className="num">${data.estimatedCost.toFixed(6)}</div><div className="lbl">estimated cost</div></div>
      </div>

      <Heatmap history={data.history ?? []} metric={metric} onMetric={setMetric} />

      <h2>By model</h2>
      <div className="card">
        {Object.entries(data.byModel ?? {}).length === 0 && <div className="muted">No model usage yet.</div>}
        <table>
          <thead><tr><th>Model</th><th>Requests</th><th>Input</th><th>Output</th><th>Cached</th><th>Cost</th></tr></thead>
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

      <h2>By provider</h2>
      <div className="card">
        {Object.entries(data.byProvider ?? {}).length === 0 && <div className="muted">No provider usage yet.</div>}
        <table>
          <thead><tr><th>Provider</th><th>Requests</th><th>Cost</th></tr></thead>
          <tbody>
            {Object.entries(data.byProvider ?? {}).map(([id, p]: [string, any]) => (
              <tr key={id}>
                <td className="mono">{id}</td>
                <td>{p.requests}</td>
                <td>${p.cost.toFixed(6)}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
  const weeks = heatWeeks(new Date());
  const byDate = new Map(history.map((h) => [h.date, h]));
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
  const unit = metric === "cost" ? "estimated cost" : "tokens";

  return (
    <>
      <div className="row heat-head">
        <h2>Cost history</h2>
        {/* Segmented control: one grey track, the chosen metric lifted onto
            a white pill. */}
        <span className="right segmented">
          <button aria-pressed={metric === "cost"} onClick={() => onMetric("cost")}>费用</button>
          <button aria-pressed={metric === "tokens"} onClick={() => onMetric("tokens")}>Tokens</button>
        </span>
      </div>
      <div className="card">
        <div className="heat-legend">
          <span className="muted">
            {metric === "cost" ? formatCost(total) : total.toLocaleString()} {unit} · 最高一天{" "}
            {metric === "cost" ? formatCost(best) : best.toLocaleString()} · 近 {WEEKS} 周
          </span>
          <span className="right muted">
            少 <i className="heat-cell" /> <i className="heat-cell l1" /> <i className="heat-cell l2" />{" "}
            <i className="heat-cell l3" /> <i className="heat-cell l4" /> 多
          </span>
        </div>
        <div className="heat-scroll">
          <div className="heat-months" style={{ gridTemplateColumns: `repeat(${weeks.length}, ${CELL}px)`, gap: GAP }}>
            {monthTicks(weeks).map((tick) => (
              <span key={tick.index} style={{ gridColumn: tick.index + 1 }}>{tick.label}</span>
            ))}
          </div>
          <div className="heat-grid" style={{ gridTemplateColumns: `repeat(${weeks.length}, ${CELL}px)`, gap: GAP }}>
            {weeks.flat().map((d) => {
              const key = localDayKey(d);
              const bucket = byDate.get(key);
              const value = valueOf(bucket);
              return (
                <div
                  key={key}
                  className={`heat-cell l${levelOf(value)}`}
                  title={`${key} · ${metric === "cost" ? formatCost(value) : `${value.toLocaleString()} tokens`}${
                    bucket ? ` · ${bucket.requests} requests` : ""
                  }`}
                />
              );
            })}
          </div>
        </div>
        {total === 0 && <div className="muted">这一窗口内还没有用量。</div>}
      </div>
    </>
  );
}
