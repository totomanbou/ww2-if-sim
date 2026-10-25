import { parseDate } from "./date";
import type { Faction, Scenario, SimMap } from "./types";

/** Identifies saved scenario files. */
export const SCENARIO_FORMAT = "ww2-if-sim/scenario@1";

export const INDUSTRY_MAX = 1000;

export function cloneScenario(s: Scenario): Scenario {
  const out: Scenario = JSON.parse(JSON.stringify(s));
  for (const country of Object.values(out.countries)) delete (country as { capital?: unknown }).capital;
  return out;
}

/** Earliest war date per country (null = never enters a war in this scenario). */
export function entryDates(s: Scenario): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const tag of Object.keys(s.countries)) out[tag] = null;
  for (const w of s.wars) {
    for (const t of [...w.a, ...w.b]) {
      const cur = out[t];
      if (cur == null || parseDate(w.date) < parseDate(cur)) out[t] = w.date;
    }
  }
  return out;
}

/** Wars a country takes part in, with its enemies, in date order. */
export function warsOf(s: Scenario, tag: string): { date: string; enemies: string[]; note?: string }[] {
  return s.wars
    .filter((w) => w.a.includes(tag) || w.b.includes(tag))
    .map((w) => ({ date: w.date, enemies: w.a.includes(tag) ? w.b : w.a, note: w.note }))
    .sort((p, q) => parseDate(p.date) - parseDate(q.date));
}

/** The original capital is fixed by the map and cannot be overridden by scenario settings. */
export function capitalOf(map: SimMap, tag: string): number {
  const fixed = map.countries[tag]?.defaultCapital ?? -1;
  return map.states[fixed]?.owner === tag ? fixed : map.states.findIndex((state) => state.owner === tag);
}

export const clampIndustry = (v: number) => (Number.isFinite(v) ? Math.min(INDUSTRY_MAX, Math.max(0, v)) : 0);
export const clampShipbuilding = clampIndustry;
export const clampStability = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/**
 * Saved file: industry, shipbuilding, stability and faction per country plus the seed. Old capital fields are
 * ignored. War dates follow the factions (applyFactions at start); invulnerable states are fixed by the preset.
 */
export interface ScenarioFile {
  format: typeof SCENARIO_FORMAT;
  name: string;
  seed: number;
  /** Map revision hint retained for compatibility with existing saved files. */
  mapStates: number;
  /** `faction` is optional: files saved before factions could be changed keep the preset's. */
  countries: Record<string, { industry: number; shipbuilding: number; stability: number; faction?: Faction }>;
}

export function toScenarioFile(s: Scenario, map: SimMap): ScenarioFile {
  const countries: ScenarioFile["countries"] = {};
  for (const [tag, c] of Object.entries(s.countries)) {
    countries[tag] = { industry: c.industry, shipbuilding: c.shipbuilding, stability: c.stability, faction: c.faction };
  }
  return { format: SCENARIO_FORMAT, name: s.name, seed: s.seed, mapStates: map.states.length, countries };
}

/**
 * Applies a saved file onto the preset `base`. Unknown countries are ignored; out-of-range values are
 * clamped; obsolete capital overrides are ignored, including valid overrides on the same map.
 * Throws on files that are not scenario files. Returns the new scenario and human-readable warnings.
 */
export function applyScenarioFile(text: string, base: Scenario, map: SimMap): { scenario: Scenario; warnings: string[] } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("JSONとして読み込めません");
  }
  const f = data as Partial<ScenarioFile>;
  if (!f || typeof f !== "object" || f.format !== SCENARIO_FORMAT || typeof f.countries !== "object" || !f.countries) {
    throw new Error("このゲームのシナリオファイルではありません");
  }
  const warnings: string[] = [];
  const out = cloneScenario(base);
  if (typeof f.name === "string" && f.name.trim()) out.name = f.name.slice(0, 100);
  if (typeof f.seed === "number" && Number.isInteger(f.seed)) out.seed = f.seed;
  else warnings.push("シードが不正なため、プリセットの値を使います");
  const mapMismatch = f.mapStates !== map.states.length;
  if (mapMismatch) warnings.push("保存時と地図が異なるため、現在の地図と元の首都を使用します");
  let legacyCapital = false;
  for (const [tag, c] of Object.entries(f.countries)) {
    const dst = out.countries[tag];
    if (!dst) {
      warnings.push(`不明な国 ${tag} を無視しました`);
      continue;
    }
    if (!c || typeof c !== "object") continue;
    if (typeof c.industry === "number") {
      const v = clampIndustry(c.industry);
      if (v !== c.industry) warnings.push(`${dst.name}の陸軍生産力を範囲内(0〜${INDUSTRY_MAX})に直しました`);
      dst.industry = v;
    }
    if (typeof c.shipbuilding === "number") {
      const v = clampShipbuilding(c.shipbuilding);
      if (v !== c.shipbuilding) warnings.push(`${dst.name}の海軍生産力を範囲内(0〜${INDUSTRY_MAX})に直しました`);
      dst.shipbuilding = v;
    }
    if (typeof c.stability === "number") {
      const v = clampStability(c.stability);
      if (v !== c.stability) warnings.push(`${dst.name}の政治安定性を範囲内(0.0〜1.0)に直しました`);
      dst.stability = v;
    }
    if ("faction" in c) {
      if (c.faction === "axis" || c.faction === "allies" || c.faction === "neutral") dst.faction = c.faction;
      else warnings.push(`${dst.name}の陣営が不正なため、プリセットの値を使います`);
    }
    if ("capital" in c) legacyCapital = true;
  }
  if (legacyCapital) warnings.push("首都の変更設定は読み込まず、元の首都を使用します");
  return { scenario: out, warnings };
}
