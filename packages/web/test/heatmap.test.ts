import test from "node:test";
import assert from "node:assert/strict";
import { heatWeeks } from "../src/views/Usage.tsx";

/**
 * The activity heatmap's day grid.
 *
 * The grid is drawn as `grid-auto-flow: column` over a flat list of days, with
 * seven rows per column, so **the position of a day is decided entirely by
 * `heatWeeks()`**: a day that lands at index `i` is drawn in row `i % 7` of
 * column `floor(i / 7)`. Every assertion below is therefore about the calendar
 * arithmetic, not about styling.
 *
 * This was wrong by one day, and only showed on a Sunday: the last column was
 * the week *after* today, so today rendered on row 5 (Saturday's row) instead
 * of row 6, the whole grid began on a Tuesday, and one column was days that had
 * not happened yet.
 */

/** `YYYY-MM-DD` in the host's own time zone — the same key the grid groups by. */
function key(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Every weekday, so an off-by-one cannot hide behind the day the suite runs. */
const WEEK: ReadonlyArray<{ label: string; day: number }> = [
  { label: "Monday", day: 1 },
  { label: "Tuesday", day: 2 },
  { label: "Wednesday", day: 3 },
  { label: "Thursday", day: 4 },
  { label: "Friday", day: 5 },
  { label: "Saturday", day: 6 },
  { label: "Sunday", day: 0 },
];

test("every column is a Monday-to-Sunday week, whichever day today is", () => {
  for (const { label } of WEEK) {
    // The Monday of one fixed week, then walk forward through all seven days.
    for (let offset = 0; offset < 7; offset++) {
      const today = new Date(2026, 9, 26 + offset); // Mon 26 Oct 2026 … Sun 1 Nov 2026
      const weeks = heatWeeks(today, 26);
      const flat = weeks.flat();
      assert.equal(flat[0]!.getDay(), 1, `${label}: row 0 must be a Monday (${key(flat[0]!)})`);
      assert.equal(flat[6]!.getDay(), 0, `${label}: row 6 must be a Sunday (${key(flat[6]!)})`);
      for (const column of weeks) {
        assert.equal(column.length, 7, `${label}: every column has seven days`);
        assert.equal(column[0]!.getDay(), 1, `${label}: a column starts on Monday`);
      }
    }
  }
});

test("today sits in the last column, at its own weekday's row", () => {
  for (let offset = 0; offset < 7; offset++) {
    const today = new Date(2026, 9, 26 + offset); // Mon 26 Oct … Sun 1 Nov 2026
    const flat = heatWeeks(today, 26).flat();
    const index = flat.findIndex((d) => key(d) === key(today));
    assert.notEqual(index, -1, `${key(today)} is in the grid at all`);
    assert.equal(index % 7, (today.getDay() + 6) % 7, `${key(today)} is drawn on its own weekday row`);
    assert.equal(Math.floor(index / 7), 25, `${key(today)} is in the last (26th) column`);
  }
});

test("the grid never draws a day after today", () => {
  for (let offset = 0; offset < 7; offset++) {
    const today = new Date(2026, 9, 26 + offset);
    const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const flat = heatWeeks(today, 26).flat();
    // The only allowed future days are the rest of this week (Tue…Sun after a
    // Monday), never the following week.
    for (const d of flat) {
      assert.ok(d.getTime() - midnight.getTime() < 7 * 86_400_000, `${key(d)} is not more than this week away from ${key(today)}`);
    }
    // And the last day of the grid is the Sunday that closes today's week.
    const last = flat[flat.length - 1]!;
    assert.equal(last.getDay(), 0, "the grid ends on a Sunday");
    assert.equal(key(last), key(new Date(midnight.getTime() + (6 - ((midnight.getDay() + 6) % 7)) * 86_400_000)));
  }
});

test("the window is exactly the number of weeks asked for", () => {
  const today = new Date(2026, 10, 1);
  for (const weeks of [4, 12, 26, 52]) {
    const grid = heatWeeks(today, weeks);
    assert.equal(grid.length, weeks, `${weeks} columns`);
    assert.equal(grid.flat().length, weeks * 7, `${weeks * 7} days`);
  }
});

test("every day of the window is present exactly once, in order", () => {
  const today = new Date(2026, 10, 1);
  const flat = heatWeeks(today, 26).flat();
  const seen = new Set<string>();
  for (let i = 0; i < flat.length; i++) {
    const k = key(flat[i]!);
    assert.ok(!seen.has(k), `${k} appears once`);
    seen.add(k);
    if (i > 0) {
      const step = flat[i]!.getTime() - flat[i - 1]!.getTime();
      assert.equal(step, 86_400_000, `${k} follows the previous day by exactly one day`);
    }
  }
  assert.equal(seen.size, 26 * 7, "no day is missing");
});
