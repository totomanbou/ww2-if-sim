/**
 * Parameter sweep for tuning: runs the historical preset for each candidate in a JSON file and prints
 * one line per candidate (win shares, end dates, key event dates).
 * Usage: tsx scripts/sweep.ts <candidates.json> [--runs 100]
 *   candidates.json: [{ "label": "...", "config": {...}, "mask": {...} }, ...]  (mask omitted = mask.ts)
 */
import { readFileSync } from "node:fs";
import { MASK, createSimulation, runToEnd, type MaskTable, type Scenario, type SimConfig, type SimMap } from "../src/sim";

const file = process.argv[2];
const ri = process.argv.indexOf("--runs");
const runs = ri > 0 ? Number(process.argv[ri + 1]) : 100;
const root = new URL("../", import.meta.url);
const map: SimMap = JSON.parse(readFileSync(new URL("data/map.json", root), "utf8"));
const scenario: Scenario = JSON.parse(readFileSync(new URL("data/presets/historical.json", root), "utf8"));
const cands: { label: string; config?: Partial<SimConfig>; mask?: MaskTable }[] = JSON.parse(readFileSync(file, "utf8"));

const yearOf = (iso: string | undefined) => (iso ? (Number(iso.slice(0, 4)) + (Number(iso.slice(5, 7)) - 1) / 12).toFixed(1) : " -  ");
const median = <T,>(xs: T[]) => [...xs].sort()[xs.length >> 1];
for (const c of cands) {
  const w = { allies: 0, axis: 0, stalemate: 0 };
  const ends: string[] = [];
  const key: Record<string, string[]> = {};
  for (let k = 0; k < runs; k++) {
    const sim = createSimulation(map, scenario, { seed: 1 + k, config: c.config, mask: c.mask ?? MASK });
    const r = runToEnd(sim);
    w[r.winner]++;
    ends.push(r.endDate);
    for (const [name, type, tag] of [["FRA-", "capitulation", "FRA"], ["UK@", "capitalFall", "UK"], ["SOV@", "capitalFall", "SOV"],
      ["ITA-", "capitulation", "ITA"], ["GER@", "capitalFall", "GER"], ["JAP@", "capitalFall", "JAP"], ["CHN-", "capitulation", "CHN"]] as const) {
      const e = sim.events.find((x) => x.type === type && x.countries[0] === tag);
      (key[name] ??= []).push(e ? e.date : "9999");
    }
  }
  const pct = (n: number) => `${Math.round((100 * n) / runs)}`.padStart(3);
  const ev = Object.entries(key).map(([n, d]) => {
    const hit = d.filter((x) => x !== "9999");
    return `${n}${hit.length === runs ? "" : `(${pct(hit.length).trim()}%)`}${yearOf(hit.length ? median(hit) : undefined)}`;
  }).join(" ");
  console.log(`${c.label.padEnd(28)} A${pct(w.allies)} X${pct(w.axis)} S${pct(w.stalemate)}  end ${yearOf(median(ends))}  | ${ev}`);
}
