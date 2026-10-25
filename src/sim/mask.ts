/**
 * Hidden mask coefficients: yearly army growth = industry × stability × mask(country, year).
 * Represents rearmament programmes and similar; never shown in the UI. Missing entries are 1.0.
 * The navy is not masked (it grows by shipbuilding × stability).
 *
 * Re-tuned after army allocation across front lines, support through own-side territory, the revival of
 * liberated allies, transit time, "colonies stay with a capitulated country", the low priority of the Soviet
 * and Chinese fronts, the slow advance in China, France's capitulation on losing Paris, the indirect-front priority,
 * the overseas distance decay and the tripled Soviet losses against Germany (scripts/tune.ts
 * random search, then scripts/sweep.ts), together with the
 * coefficients in config.ts, to reach an allied win rate of about 90 % on the historical preset
 * (target 85–95 %, which takes priority over historical accuracy). Results: see docs/DEVELOPMENT.md「勝率の調整」.
 * Periods: 1939–41 (early war), 1942–44 (total war), 1945– (1.0 for everyone).
 */
export type MaskTable = Record<string, Record<number, number>>;

/** Same factor for 1939–41 and for 1942–44; 1.0 from 1945. */
function periods(early: number, mid: number): Record<number, number> {
  const out: Record<number, number> = {};
  for (let y = 1939; y <= 1944; y++) out[y] = y <= 1941 ? early : mid;
  return out;
}

export const MASK: MaskTable = {
  // Germany: on top of its 5-year head start (config.initialYearsByCountry). 1939–41 from the search (rng 16); the
  // 1942–44 value sets the final win rate. After the Barbarossa surprise, the Soviet army at 1.0 × Germany's and Free
  // France (seeds 1–200): 1.4 → 99.0 %, 1.7 → 95.0 %, 1.9 → 90.5 % (seeds 201–400: 92.0 %).
  GER: periods(1.05, 1.9),
  // Italy: Italy can only be invaded by sea after North Africa is cleared. Searched (rng 16); its North African share
  // is set by config.regionPriority.
  ITA: periods(1.72, 1.2),
  // Japan: militarized economy.
  JAP: periods(1.79, 1.61),
  // USA: no production before entering the war (config.preWarGrowth); 1942–44 raised (Victory Program).
  USA: periods(1, 1.43),
  // USSR: no production before its war (config.preWarGrowth). User requirement: strong enough production that Moscow
  // does not fall in the German offensive after the winter of 1941–42 (mobilisation and the evacuated industry of 1941
  // –42). Measured (16 seeds; it had fallen in all of them, February–August 1942, with 2.5 / 2.0, and still in 14 with
  // 1942–44 at 3.5): 1941 5 / 1942 4 → 6 falls in 1942; 8 / 5 → 1 (August 1942); 12 / 6 → none in 1942. Chosen 8 / 5;
  // 1943–44 stay at 2.0.
  SOV: { ...periods(2.5, 2.0), 1941: 8, 1942: 5 },
  // UK: the Empire; low early value with a small standing army (config.initialYearsByCountry.UK) so that France falls
  // in June 1940. Searched (scripts/tune.ts, rng 16) with the other masks after the 1938-based production values.
  UK: periods(0.85, 1.6),
  // British India (its own country since 2026-10-25, user requirement): little industry (its share of the UK's, 2.6)
  // but a large volunteer army (about 2.5 million men by 1945). With the Axis landing ban on India and Japan's cap
  // there (config.ts), measured (16 seeds, initial army 2 years): 3 / 5 → India never capitulates, Singapore falls in
  // 12; 2 / 4 with 1 year → India capitulates in 3. Without the ban and cap India capitulated in 2–6 of 8 at any value.
  IND: periods(3, 5),
  CHN: periods(2.99, 3.7),
};

/**
 * Hidden capitulation mask (user requirement: China gets special data so that it capitulates less easily): multiplies
 * the stability-based capitulation threshold (config.capitulationThreshold). Missing entries are 1.0. Never shown.
 * China: 0.42 × 2.2 → 0.92 of its original territory (industry weight) must be lost; it had capitulated in
 * November 1939 in every seed (with 0.6).
 */
export const CAPITULATION_MASK: Record<string, number> = {
  CHN: 2.2,
};

export function maskFactor(tag: string, year: number, table: MaskTable = MASK): number {
  return table[tag]?.[year] ?? 1.0;
}
