/**
 * All tunable constants of the simulation (and the playback speed used by the UI).
 * Tuning: lossRate, advanceRate, advanceMax, initialYears, fleetBattleChance and fleetBattleLossRate
 * were tuned together with src/sim/mask.ts (random search in scripts/tune.ts, validated with
 * scripts/sweep.ts / batch.ts on 200 seeds) to reach an allied win rate of about 90 % on the
 * historical preset; re-tuned after the navy was added. Values given by the
 * specification (navalPenalty, occupiedIndustryRate, capitulationThreshold, axisBWeeks, the
 * comparison and growth modes) are kept at their specified defaults.
 */
export interface SimConfig {
  /** Simulated days per update. 7 is retained for explicit legacy comparisons; production defaults to 3.5. */
  stepDays: 3.5 | 7;
  /** First tick (ISO date, UTC). */
  startDate: string;
  /** Cut-off date; reaching it without a victory is a stalemate. */
  endDate: string;
  /** "weekly": split the weekly 1/52 growth across half-steps. "yearly": add it all once per 1 September. */
  growthMode: "weekly" | "yearly";
  /**
   * How much of each country's army fights on each front line:
   * "allocated" (default): the army is split across its front lines by weight
   *   front length × enemy strength on the line × 1 / (1 + distance from the capital / allocationDistanceKm);
   * "nation": the whole army on every line; "divided": army / the country's front count on every line.
   */
  frontComparisonMode: "allocated" | "nation" | "divided";
  /** Distance (km, capital → the country's front on a line) at which the allocation weight halves. */
  allocationDistanceKm: number;
  /**
   * Overseas lines (none of the country's side's front states there is on its capital's land mass): the
   * distance counts this many times as much in the allocation weight, so it decays faster.
   */
  overseasDistanceFactor: number;
  /**
   * Fronts other countries of the same side give low priority (tag → factor, "allocated" mode): a country's
   * allocation weight on a line is multiplied by the edge-weighted average over its side's front holders there
   * of this factor (1 for unlisted holders and for the country itself).
   */
  lowPriorityFronts: Record<string, number>;
  /**
   * Priority by enemy (tag → enemy tag → factor, "allocated" mode): a country's allocation weight on a line is
   * multiplied by 1 + (factor − 1) × the share of the enemy side's front edges there held by that enemy.
   */
  enemyPriority: Record<string, Record<string, number>>;
  /**
   * Land other countries of the same side cannot send troops to (tags, "allocated" mode): a country's allocation
   * weight on a line is multiplied by the share of its side's front states there that are neither on this land
   * (sim.landOf) nor held by a listed country now, not counting states the country holds itself (it may defend its own). A line entirely on such land
   * gets nothing. The listed countries themselves (on their own land) and their enemies are not affected.
   */
  closedLand: string[];
  /**
   * Fleet placement weight of a sea route the country cannot land through now (landing bans) but the enemy can
   * (defence); routes usable for its own landings count 1, routes closed both ways 0.
   */
  fleetDefenceWeight: number;
  /**
   * Aid in kind (Lend-Lease): from `start`, the share `share` of each donor's army growth goes to the recipient's
   * army instead (while the recipient is at war and has not capitulated). `share` is a number or a schedule
   * [[date, share], ...] interpolated like lossFactors. Donors that do not produce yet (e.g. the USA before its war,
   * config.preWarGrowth) give nothing. Entries apply in order, each to what the donor still has (two 50 % entries
   * for the same donor move 75 %).
   */
  lendLease: { from: string[]; to: string; share: number | [string, number][]; start: string }[];
  /**
   * Date-limited landing bans: before `until`, countries of `faction` (except the tags in `except`) cannot land on
   * states whose centre lies in one of `boxes` ([west, south, east, north]), except states originally of the
   * countries in `exceptLand`. Land attacks are not affected.
   */
  landingBans: {
    name: string; faction: "axis" | "allies"; except: string[]; boxes: [number, number, number, number][];
    exceptLand?: string[]; until: string;
  }[];
  /** Separate amphibious approaches sharing an embarkation state, and separate them from ground combat. */
  landingTheatres: { name: string; land: string[]; boxes: [number, number, number, number][] }[];
  /** Sea-attack allocation, target weights and committed effort by original land (land attacks and defence unchanged). */
  landingPreferences: { faction: "axis" | "allies"; except: string[]; land: string[]; factor: number;
    boxes: [number, number, number, number][] }[];
  /** Countries supporting foreign fronts only through a continuous friendly land path from their capital. */
  landSupportOnly: string[];
  /** Hard deployment bans on foreign-held European fronts, even with a friendly land path or mixed holders. */
  frontDeploymentBans: { country: string; heldBy: string[]; land: string[]; boxes: [number, number, number, number][]; theatres: string[] }[];
  /**
   * Factor on a country's allocation weight on lines where it holds no front state itself (its own or occupied
   * territory), i.e. where it only supports others of its side ("allocated" mode).
   */
  indirectFrontPriority: number;
  /** Named regions as lists of [west, south, east, north] boxes of state centres (for regionPriority). */
  regions: Record<string, [number, number, number, number][]>;
  /**
   * Allocation mask by region (tag → region → factor, "allocated" mode): a country's weight on a line is multiplied by
   * 1 + (factor − 1) × the share of its side's front states on the line that lie in the region.
   */
  regionPriority: Record<string, Record<string, number>>;
  /**
   * Upper limit of a country's army in a region (tag → region → army, "allocated" mode): its allocation on each line
   * times the share of its side's front states there in the region; the excess goes to its other lines.
   */
  regionCap: Record<string, Record<string, number>>;
  /**
   * Caps for a group of countries together in a region ("allocated" mode): the listed `tags`, or every country of
   * `faction` except `except`. Their army in the region together is limited; each member is scaled alike and its
   * excess goes to its own lines outside the region (as in regionCap).
   */
  regionGroupCaps: { name: string; region: string; cap: number; tags?: string[]; faction?: "axis" | "allies"; except?: string[] }[];
  /**
   * Reinforcements when an important city (map.importantCities, by name) falls to the enemy for the first time:
   * `years` of the army production of `to` (army production × stability × years, like initialYears) are added to its
   * military (once per entry and simulation, if `to` has not capitulated).
   */
  cityFallReinforcements: { city: string; to: string; years: number }[];
  /**
   * Reinforcements the first time `to` is at war with any tag in `against`: `years` of its army and navy
   * production (industry / shipbuilding × stability × years), once per entry and simulation if it has not
   * capitulated. Navy is split equally over its existing fleets; no fleets means no navy is added.
   */
  warStartReinforcements: { to: string; against: string[]; years: number }[];
  /**
   * Occupation by an ally on capitulation (tag → ally tag): the remaining territory of a capitulating country goes to
   * this ally (if it has not capitulated and is on the same side) instead of the enemy that receives it otherwise.
   */
  capitulationOccupier: Record<string, string>;
  /**
   * Holding small fronts ("allocated" mode): on its own lines a country first sets aside holdRatio × its share of
   * the enemy army there, smallest first, up to holdShare of its army; the rest is split by weight.
   */
  holdRatio: number;
  holdShare: number;
  /**
   * Fronts held first (tag → { against, ratio }): on its lines where a country in `against` has an army, the country
   * sets aside `ratio` × its share of the enemy army there (instead of holdRatio) before its other lines, and partly
   * when the whole would exceed holdShare of its army.
   */
  holdAgainst: Record<string, { against: string[]; ratio: number }>;
  /**
   * Slower advance on a country's land (tag → factor, for every side): its original territory and the states the
   * map marks as taken from it before the start (formerOwner, e.g. Japanese-occupied China). Each state captured there
   * is actually taken only with this probability, so the expected advance is multiplied by it.
   */
  slowAdvanceLand: Record<string, number>;
  /**
   * Terrain difficulty (sim.terrain: easy / normal / hard): `loss` multiplies the attacker's losses in a battle and
   * `capture` its chance to take the state ([easy, normal, hard]). Per battle, both are averaged over the target
   * states by their target weights; `capture` also multiplies each state's target weight.
   */
  terrainLoss: [number, number, number];
  /**
   * Seasons on some countries' land (sim.landOf of the target): in the listed months (1–12, by the date of the
   * step), the attacker's losses are multiplied by `loss` and its capture chance by `capture`, like the terrain
   * factors (per target state). Attackers in `exempt` are not affected: the factor is scaled by the share of the
   * attacking side's strength that is not exempt.
   */
  seasons: { name: string; land: string[]; months: number[]; loss: number; capture: number; exempt: string[] }[];
  terrainCapture: [number, number, number];
  /** Countries that capitulate as soon as they lose their capital, whatever territory they still hold (tags). */
  capitulateOnCapitalLoss: string[];
  /**
   * Countries that capitulate as soon as they hold none of their original states on the continent (the land mass
   * with the most states), even with their capital on an island (tags).
   */
  capitulateOnContinentLoss: string[];
  /**
   * Encircled pockets (own-side territory without a capital of its side, surrounded on land only by enemies and
   * without a sea route to the rest of its side) cannot capture states.
   */
  encirclement: boolean;
  /**
   * Transit time ("allocated" mode): a country's troops in each map cell of transitCellDeg° move towards
   * its allocation with time constant T = distance / transitSpeedKmPerWeek weeks (at least 1), where the
   * distance is from its capital or from the nearest cell where it already has troops.
   */
  transitSpeedKmPerWeek: number;
  transitCellDeg: number;
  /** Share of an occupied state's industry that the occupier gains. */
  occupiedIndustryRate: number;
  /**
   * Share of a colonial power's industry located in its colonies (non-core states); the rest is in
   * the homeland. Used both for industry loss and for the capitulation threshold, so losing the
   * homeland weighs more than losing remote colonies. Not tuned (design value).
   */
  colonyIndustryShare: number;
  /** Loss L = lossRate × smaller compared strength; defender loses L, attacker 2L. */
  lossRate: number;
  /**
   * Loss multipliers by matchup (tag → enemy tag → factor): in a battle where the enemy is on the other side,
   * the country's share of the losses is multiplied by the factor (the largest one if several apply; factors below 1
   * reduce losses). A factor can be
   * a schedule of [ISO date, factor] points: constant before the first and after the last, linear in between.
   */
  lossFactors: Record<string, Record<string, number | [string, number][]>>;
  /**
   * Defence zones (e.g. the fortified approaches to a capital): a state within `radiusKm` of `center` [lon, lat]
   * while owned by `defender` is taken with its capture chance (and target weight) multiplied by `capture` (a number
   * or a schedule [[date, factor], ...] as in strengthFactors), on top of terrain and seasons.
   */
  defenceZones: { name: string; defender: string; center: [number, number]; radiusKm: number; capture: number | [string, number][] }[];
  /** Attacker strength multiplier on sea-only fronts (landings). */
  navalPenalty: number;
  /**
   * Landing strength by country (tag → factor, or a schedule [[date, factor], ...] as in strengthFactors): multiplies
   * the country's strength in the landing comparison (navalPenalty × attackers vs defenders) only, not in land battles.
   */
  landingStrength: Record<string, number | [string, number][]>;
  /**
   * Capital lost AND at least the country's threshold share of the original territory (industry weight) lost →
   * capitulation. The threshold depends on political stability (user requirement: stable countries hold out
   * longer): capitulationThreshold + capitulationStabilitySlope × (stability − capitulationStabilityRef), times the
   * hidden capitulation mask (mask.ts CAPITULATION_MASK), clamped to capitulationThresholdRange.
   */
  capitulationThreshold: number;
  capitulationStabilitySlope: number;
  capitulationStabilityRef: number;
  capitulationThresholdRange: [number, number];
  /**
   * Countries whose capitulation share counts only their own land (homeland and colonies, sim.landOf), not the
   * territory they had taken from others before the start (map formerOwner, e.g. Japan's occupied China).
   */
  capitulationOwnLandOnly: string[];
  /** Initial military = industry × stability × initialYears. */
  initialYears: number;
  /** Per-country override of initialYears (tag → years). */
  initialYearsByCountry: Record<string, number>;
  /**
   * Per-country factor on military growth until the country first enters a war (tag → factor;
   * countries not listed grow normally). 0 = no military production before entering the war.
   */
  preWarGrowth: Record<string, number>;
  /** Expected states taken per week per pair = advanceRate × (ratio − 1), capped by advanceMax. */
  advanceRate: number;
  advanceMax: number;
  /**
   * Broad fronts: on a line whose attacking holders have more front edges than this, advanceRate and advanceMax are
   * multiplied by edges / advanceBreadthEdges.
   */
  advanceBreadthEdges: number;
  /**
   * A state captured by a member of the same faction as its original (still fighting) owner is
   * handed back to that owner (liberation).
   */
  liberateToOriginalOwner: boolean;
  /**
   * Surprise attacks (defender tag → { weeks, factor }): when a listed country is attacked by a war declaration, its
   * combat strength starts at factor × normal and recovers linearly to 1 over `weeks` weeks.
   */
  surprise: Record<string, { weeks: number; factor: number }>;
  /**
   * Combat strength multiplier by country (tag → factor, or a schedule [[date, factor], ...] interpolated linearly
   * between the dates and constant outside them, like lossFactors), on top of the surprise factor.
   */
  strengthFactors: Record<string, number | [string, number][]>;
  /**
   * Matchup strength multiplier (tag → { against, factor }): the country's combat strength on a line is multiplied by
   * `factor` (a number, or a schedule like strengthFactors) when any country in `against` is its opponent there (on
   * the other side, at war with it, with an army on that line). Applies to attackers and defenders, land and sea.
   */
  matchupStrength: Record<string, { against: string[]; factor: number | [string, number][] }>;
  /**
   * Successor governments (capitulated tag → { tag, seat: [lon, lat] }): after the country capitulates, its liberated
   * original states go to the successor instead of reviving it, and the successor's capital is the predecessor's
   * capital when it holds it, otherwise its state nearest to `seat` (none while it holds no territory).
   */
  successors: Record<string, { tag: string; seat: [number, number] }>;
  /** Axis condition B: consecutive weeks required. */
  axisBWeeks: number;
  /**
   * Countries whose (original, fixed) capital the Axis must also hold for condition B (tags). A listed country not
   * on the allied side is left out.
   */
  axisBCapitals: string[];

  // ---- Navy ----
  /** Initial navy = shipbuilding × stability × navyInitialYears (per-country override below). */
  navyInitialYears: number;
  navyInitialYearsByCountry: Record<string, number>;
  /** One fleet per this much initial navy, at least 1 and at most maxFleets per country. */
  navyPerFleet: number;
  maxFleets: number;
  /** Weekly chance of a fleet battle in a zone where enemy fleets meet. */
  fleetBattleChance: number;
  /** In a battle each side loses fleetBattleLossRate × enemy naval power × random(0.6–1.4). */
  fleetBattleLossRate: number;
  /** Landing needs the attacker side's navy in the route's zone ≥ this × the defender side's. */
  navalSuperiority: number;
  /**
   * Sea routes longer than this (km) also need superiority in the waters at both ends (a port zone of each end,
   * see SimState.portZone): a convoy route has a single zone, so otherwise a landing would be judged only there.
   */
  longRouteKm: number;
  /**
   * Landings that need no naval superiority (attacker tag → defender tags): the attacker may land on states owned by
   * those countries whatever the navies (the landing penalty navalPenalty still applies).
   */
  landingWithoutNavy: Record<string, string[]>;
  /**
   * Sea zones a country's fleets may go to (tag → zone names, sim.zoneNames): for a listed country every other zone
   * scores 0 in the fleet deployment, so it is never a fleet target (movement paths are unchanged). Unknown names are
   * ignored; unlisted countries are unaffected.
   */
  fleetZones: Record<string, string[]>;
  /**
   * Fleet placement weight by enemy (tag → enemy tag → multiplier): a listed country's score for a sea route whose
   * enemy end is owned by the listed enemy is multiplied by it (both for its own routes and the 0.5 ally routes).
   * 0 makes the routes against that enemy attract no fleet; 1 leaves them unchanged.
   */
  fleetEnemyWeights: Record<string, Record<string, number>>;
  /** Battles where both sides are at least this strong are logged as events. */
  fleetBattleLogMin: number;

  /**
   * People per unit of combat losses (sim.losses, army + navy, both sides), for the war's death toll shown at the end
   * (civilian deaths are implied in this factor).
   */
  peoplePerLoss: number;

  // ---- Playback (UI) ----
  /** Real seconds per simulated year at 1x speed. */
  secondsPerYear: number;
  speedMin: number;
  speedMax: number;
}

export const DEFAULT_CONFIG: SimConfig = {
  stepDays: 3.5,
  startDate: "1939-09-01",
  endDate: "1950-12-31",
  growthMode: "weekly",
  // User requirement: every country splits its army across its front lines (see SimConfig).
  frontComparisonMode: "allocated",
  // Tuned (search over 1000–8000 km).
  allocationDistanceKm: 2190,
  // User requirement: the allocation weight decays faster with distance across the sea. Design value (not
  // tuned): an overseas distance counts double.
  overseasDistanceFactor: 2,
  // User requirement: the other Allies give the Soviet and Chinese fronts low priority. Design value (not
  // tuned): a quarter of the weight on a line held entirely by them.
  lowPriorityFronts: { SOV: 0.25, CHN: 0.25 },
  // Germany's special priority on its fronts against the USSR (×3, added when Germany sent too much to North Africa)
  // was removed at the user's request; the North Africa cap (regionCap) now limits that. The option stays available.
  enemyPriority: {},
  // User requirement: other countries cannot send troops to the Chinese and Soviet regions (their land, including
  // Chinese land Japan held before 1939). Replaces the effect of lowPriorityFronts there.
  closedLand: ["SOV", "CHN"],
  // User requirement: no fleets for landings that cannot happen yet. Routes closed for the country's own landings
  // still count fully while the enemy can land through them: without that, the Royal Navy left the Channel (Allied
  // landings in France are banned until 1944) and Germany invaded Britain in June 1940 in every seed. Measured (6
  // seeds): 0.25 → Germany capitulates September 1943–January 1944; 0.5 → December 1943–December 1944; 1 → October
  // 1944–September 1945 with the Italian landing in July 1943 in most runs. Chosen 1.
  fleetDefenceWeight: 1,
  // User requirement: since other countries cannot send troops to the Soviet region, the Soviet army is supported by
  // British and American production instead, like Lend-Lease (the Moscow Protocol, October 1941). 80 % of their army
  // growth until the Normandy landing (their armies could not land in Europe before), 20 % after. Measured (12 seeds):
  // a constant 20 % → the USSR capitulates in 12/12 (about September 1942), 50 % → 7/12, 70 % → 3/12, 100 % → 1/12
  // but the Western armies hardly grow; 80 % → 20 % → 1/12, Germany capitulating in 5/12 (about January 1945).
  // User requirement: China gets aid too, like the supply routes to Chiang Kai-shek (Burma Road, the Hump), from the
  // Lend-Lease Act (1941-03-11; the USA gives nothing before its own war). Listed first, so the Soviet share applies to
  // the rest. Measured (16 seeds): 10 % → China capitulates 1/16, Japan 8/16; 20 % → China 0/16, USSR 0/16, Japan
  // 14/16 (about October 1945); 30 % → the USSR capitulates 4/16. Chosen 20 %.
  lendLease: [
    { from: ["USA", "UK"], to: "CHN", share: 0.2, start: "1941-03-11" },
    { from: ["USA", "UK"], to: "SOV", share: [["1944-06-06", 0.8], ["1944-06-07", 0.2]], start: "1941-10-01" },
  ],
  // User requirement: the Western Allies cannot land on the European continent before the historical dates (with the
  // Soviet and Chinese regions closed to them they had invaded France in 1942 and Germany capitulated in May 1942).
  // Italy, Sicily, Sardinia, Corsica and the Balkans until the Sicily landing (1943-07-10); France, the Low
  // Countries, Germany, Denmark and Norway until Normandy (1944-06-06). Britain, Ireland and Iceland lie outside the
  // boxes or excepted (exceptLand: the France box overlaps Cornwall and Kent); the USSR is not affected.
  landingBans: [
    { name: "イタリア・バルカン", faction: "allies", except: ["SOV"], until: "1943-07-10",
      // Sicily, Calabria/Apulia, the rest of Italy with Sardinia and Corsica (not the Tunisian and Algerian coast), the
      // Balkans with Crete.
      boxes: [[12.3, 36.6, 15.7, 38.4], [15.5, 37.9, 19, 40], [8, 38.4, 19, 47.2], [19, 34.5, 30, 46.5]] },
    { name: "西欧・北欧", faction: "allies", except: ["SOV"], until: "1944-06-06",
      boxes: [[-5.5, 42, 8.5, 51.2], [2.4, 47, 24, 56], [4, 56, 32, 72]], exceptLand: ["UK", "IRE"] },
    // The Axis never invades the Americas (Germany had landed in Canada and the USA in some runs, up to 178 states,
    // which kept the Western Allies from finishing Germany). North America with the Caribbean, and South America; the
    // western Aleutians (east longitude, occupied by Japan in 1942) are outside.
    { name: "南北アメリカ", faction: "axis", except: [], until: "9999-12-31",
      boxes: [[-170, 7, -50, 84], [-82, -56, -34, 13]] },
    // Nor the Indian mainland (Japan had landed on India's west coast and taken New Delhi in some runs; historically it
    // attacked India only overland from Burma, at Imphal and Kohima). The Andaman Islands (east of 92.3°E, occupied in
    // 1942) and Ceylon (south of 7.9°N) are outside.
    { name: "インド本土", faction: "axis", except: [], until: "9999-12-31", boxes: [[60, 7.9, 92.3, 37.5]] },
  ],
  landingTheatres: [
    { name: "フランス方面", land: ["FRA", "BEL", "HOL"], boxes: [[-6, 47, 8.5, 54]] },
    { name: "ドイツ方面", land: ["GER", "DEN"], boxes: [[5, 47, 16, 58]] },
  ],
  // Prefer the French coast; direct German/Danish landings remain possible, with a smaller commitment.
  landingPreferences: [
    { faction: "allies", except: ["SOV"], land: ["BEL", "HOL"], factor: 0.65, boxes: [[-6, 47, 16, 58]] },
    { faction: "allies", except: ["SOV"], land: ["GER", "DEN"], factor: 0.2, boxes: [[-6, 47, 16, 58]] },
  ],
  // Soviet armies advance with the land front instead of being routed through Britain into a western landing.
  landSupportOnly: ["SOV"],
  // The USSR does not send troops to the Western Allies' European fronts, even after friendly territory joins up.
  // A Soviet-held eastern front remains available (including the advance through Poland into eastern Germany).
  frontDeploymentBans: [{ country: "SOV",
    heldBy: ["UK", "IND", "USA", "CAN", "AST", "NZL", "SAF", "FRA", "FFR", "BEL", "HOL", "NEI", "GER", "ITA", "SPA", "POR"],
    land: ["UK", "FRA", "BEL", "HOL", "ITA", "SPA", "POR"],
    boxes: [[-12, 35, 20, 61]], theatres: ["フランス方面", "ドイツ方面"] }],
  // User requirement: lower priority for fronts that do not touch the country's own territory (original or
  // occupied). Design value (not tuned): half the weight.
  indirectFrontPriority: 0.5,
  // User requirement: in North Africa the Axis army should be about 70 % Italian and 30 % German, and about 70 % of
  // what it would be without this mask (allocation sampled monthly over 1940–43, 30 seeds, each holder's allocation
  // attributed by its own front states there; see docs/DEVELOPMENT.md「北アフリカの独伊の比率」): without the mask 22.1 German /
  // 38.5 Italian, with it 10.9 / 31.8 (26:74, 70 %). Germany's factor covers all of Africa (AFR), Italy's only North
  // Africa (NAF), since the North African line often runs on into East Africa.
  // EAF: East Africa (Italian East Africa, the Sudan south of 15°N, Kenya, the Somalilands; Eritrea up to 18.5°N).
  regions: {
    AFR: [[-20, 12, 35, 37.2], [-20, -35, 52, 12]], NAF: [[-17, 15, 33, 37.2]], EAF: [[21, -12, 52, 15], [33, 15, 45, 18.5]],
    // IND: British India (the mainland west of 92.3°E, and Assam, Manipur and the hills up to the Burmese border).
    IND: [[60, 7.9, 92.3, 37.5], [92.3, 22, 94, 29.5], [94, 24, 95.2, 29.5], [95.2, 26.3, 97.4, 29.5]],
    // ITP: the Italian peninsula with Sicily and Sardinia (northern Italy, central Italy, the south, Sicily, Sardinia).
    ITP: [[6.6, 43.6, 13.9, 47.1], [9.5, 41.2, 16.2, 44.2], [13.8, 37.9, 18.6, 42.0], [12.3, 36.6, 15.7, 38.4], [8.1, 38.8, 9.9, 41.3]],
  },
  regionPriority: { ITA: { NAF: 0.35 }, GER: { AFR: 0.4 } },
  // User requirement: Germany sends at most 6 to North Africa (the Afrika Korps was a few divisions).
  // User requirement: the Allies must not be overrun in East Africa (Italy had taken 138 of the 181 Allied states there
  // by October 1940, with 34 Italian and 32 German troops against 11 British). Germany sent no troops there, and
  // Italian East Africa was cut off from Italy after June 1940: Germany 0, Italy at most 12 (its garrison). Measured
  // (seed 1): Italy 5 or 8 → Italian East Africa falls by October 1940; 12 → the Allies lose 2–4 states (British
  // Somaliland, as historically) and Italian East Africa falls by mid-1941 (historically May–November 1941).
  // Japan in India at most 8 (user requirement: India must not fall at once to Japan; it had sent 80–95 into India by
  // early 1942 and taken New Delhi by April in some runs; historically about three divisions attacked at Imphal).
  regionCap: { GER: { NAF: 6, EAF: 0 }, ITA: { EAF: 12 }, JAP: { IND: 8 } },
  // User requirement (Germany collapsed within weeks of the Italian landing): the Western Allies' armies, idle while
  // landings were banned, had all poured into Italy at once (about 210: UK 75, USA 73, Canada 22, ...) and on overland
  // into France and Germany. Shipping and supply limited the Allied commitment in Italy (about 20 divisions against a
  // similar German force): the Western Allies together have at most 40 in Italy. Measured (10 seeds, Germany's
  // capitulation): no cap → as early as October 1943; 80 → May 1944–April 1945; 50 → August 1944–May 1945;
  // 30 → October 1944–November 1945.
  regionGroupCaps: [{ name: "西側連合国のイタリア", region: "ITP", cap: 40, faction: "allies", except: ["SOV"] }],
  // User requirement: the USSR gets one year of its army production when Kiev falls and again when Smolensk falls
  // (reserves mobilized; with the preset 36.8 × 0.8 ≈ 29 each; first 50 each, then changed by the user).
  // User requirement (Germany collapsed right after Italy): when Italy capitulates, Germany occupies what Italy
  // still holds (Operation Achse, September 1943) instead of the Allies receiving all of Italy up to the Alps, from
  // where they had invaded France and Germany overland within weeks.
  capitulationOccupier: { ITA: "GER" },
  cityFallReinforcements: [
    { city: "キエフ", to: "SOV", years: 1 },
    { city: "スモレンスク", to: "SOV", years: 1 },
  ],
  // User requirement: Japan was too weak at the start of the Pacific War; the build-up before Pearl Harbor.
  warStartReinforcements: [{ to: "JAP", against: ["USA", "UK"], years: 2 }],
  // Design values: at least half the enemy's army on small fronts (user requirement; was parity, 1), at most half the
  // army set aside for that (so a weak country is not overrun on a minor front such as Finland's while its main
  // front gets the rest).
  holdRatio: 0.5,
  holdShare: 0.5,
  // User requirement: Germany meets the Western Allies' landings with about as many troops as they bring (it had
  // held France with about a third of the Allied army there while two thirds of its army stayed in the East).
  holdAgainst: { GER: { against: ["UK", "USA", "CAN", "FFR", "AST", "NZL", "SAF", "POL"], ratio: 1 } },
  // User requirement: on Chinese soil both sides advance more slowly (first 50 % slower, then "further slower" together
  // with China's strength penalty, strengthFactors). Measured with the penalty (16 seeds each): 0.25 → China
  // capitulates in every run (about November 1940), 0.1 → 15/16 (about November 1941), 0.075 → 4/16 (about October
  // 1943), 0.05 → never, holding at least about 40 % of its states (as historically: Japan held the east). Chosen 0.05.
  slowAdvanceLand: { CHN: 0.05 },
  // User requirement: terrain difficulty per state (scripts/map/terrain.ts). Easy terrain lowers the attacker's
  // losses and raises its chance to take the state, hard terrain the reverse. Design values (not tuned).
  terrainLoss: [0.75, 1, 1.5],
  terrainCapture: [1.3, 1, 0.6],
  // User requirement: on Soviet land the attacker is at a disadvantage in winter (December–February) and in the mud
  // seasons (rasputitsa, spring and autumn). The Red Army is not affected by the winter (it was prepared for it, as
  // in the Moscow counter-offensive of December 1941); the mud slows every attacker. Values: see docs/DEVELOPMENT.md「冬季と泥濘期」.
  seasons: [
    { name: "冬季", land: ["SOV"], months: [12, 1, 2], loss: 1.5, capture: 0.5, exempt: ["SOV"] },
    { name: "泥濘期", land: ["SOV"], months: [3, 4, 10, 11], loss: 1.25, capture: 0.5, exempt: [] },
  ],
  // User requirement: France capitulates as soon as Paris falls.
  capitulateOnCapitalLoss: ["FRA"],
  // User requirement: Denmark capitulates once it has lost all of Jutland (Copenhagen is on Zealand, which the
  // Germans could not reach without naval superiority, so Denmark kept fighting and opened a way into Germany).
  capitulateOnContinentLoss: ["DEN"],
  // User requirement: no captures from encircled territory.
  encirclement: true,
  // User requirement: troops take time to reach a front, more the farther it is. Tuned (search over
  // 200–1000 km/week): 570 km/week, e.g. ~12 weeks' time constant from Washington to Europe.
  transitSpeedKmPerWeek: 570,
  transitCellDeg: 5,
  occupiedIndustryRate: 0.25,
  colonyIndustryShare: 0.25,
  // Tuned (random search over 0.008–0.03): 0.8 % of the smaller side per week (the lower bound of the search).
  lossRate: 0.008,
  // User requirement: the USSR's losses against Germany are tripled until the end of November 1941 and return
  // linearly to normal by the end of July 1942 (a constant ×3 had shrunk the Soviet army every year, from 210 on the
  // front in 1941 to 32 in 1944).
  // Germany's losses against the USSR are halved until the end of December 1942 (user requirement), normal from 1943.
  lossFactors: {
    SOV: { GER: [["1941-11-30", 3], ["1942-07-31", 1]] },
    GER: { SOV: [["1942-12-31", 0.5], ["1943-01-01", 1]] },
  },
  navalPenalty: 0.5,
  // User requirement: the first German offensive stops just short of Moscow and the second (1942) does not take it.
  // Within 250 km of Moscow, Soviet-held states are taken at 0.15× the chance until the end of 1942, normal from April
  // 1943. Measured (16 seeds, with matchupStrength.GER): Moscow falls in 1941 in 1, in 1942 in none; in December
  // 1941 the nearest Axis-held state is a median 177 km from Moscow (before: 393 km, Moscow falling in 1942 in 1 of 12;
  // the stronger German offensive alone took Moscow in 1941 in half the runs or more).
  defenceZones: [
    { name: "モスクワ防衛線", defender: "SOV", center: [37.62, 55.75], radiusKm: 250,
      capture: [["1942-12-31", 0.15], ["1943-03-31", 1]] },
  ],
  // User requirement: stronger Western Allied landings from D-Day (×3 in the landing comparison only), so that they get
  // ashore against a German defence held at parity (holdAgainst).
  landingStrength: Object.fromEntries(["USA", "UK", "CAN", "FFR"].map((t) => [t, [["1944-06-05", 1], ["1944-06-06", 3]] as [string, number][]])),
  capitulationThreshold: 0.6,
  // User requirement: capitulation follows political stability. 0.6 stays the value at stability 0.7 (Poland, Italy,
  // Hungary…); each 0.1 of stability moves it by 0.06: Germany (0.95) 0.75, the USSR (0.8) 0.66, Romania (0.5) 0.48,
  // China (0.4) 0.42 before its mask. Range 0.3–0.95 (a country never holds out to the very last state).
  capitulationStabilitySlope: 0.6,
  capitulationStabilityRef: 0.7,
  capitulationThresholdRange: [0.3, 0.95],
  // User requirement: Japan's capitulation counts only the home islands and the colonies, not occupied China
  // (Manchukuo included), which had kept its lost share below the threshold even with Tokyo taken.
  capitulationOwnLandOnly: ["JAP"],
  // Tuned (search over 0.5–3): standing armies of 0.73 years of output in 1939, except the countries
  // below. With the whole tuned set, Poland falls in September 1939, France in June 1940 and Berlin in 1944.
  initialYears: 0.73,
  // User requirements (stage 5):
  // - GER: 5 years of preparation for its initial military only (rearmament 1934–39); its growth
  //   afterwards is unchanged.
  // - USA: military production starts only when it enters the war; it begins with a small standing
  //   force (0.2 years of output).
  // - ITA: 3.5 years of preparation for its initial army.
  // - SOV: about 60 % of Germany's army in June 1941 at first; once Soviet losses against Germany were tripled
  //   (lossFactors) the user allowed changing it, and the search (scripts/tune.ts) also varies the ratio. Current:
  //   1.0 × Germany's median army on 1941-06-20 (265.9, 200 seeds, scripts/army-at.ts) = 265.9 = 9.03 years of
  //   its output (36.8 × 0.8 per year). Lowered from the search's 1.3 because the USSR then attacked first in
  //   every run (user requirement: the Axis strikes first; see also `surprise`). Re-derive whenever the tuning changes.
  // - FFR (Free France): a token force at the start (0.1 years; about 7,000 men in summer 1940).
  // - UK: a small standing army (0.5 years; the BEF was small). With the 1938-based army production a large British
  //   army in France had slowed the 1940 campaign until August (user requirement: Poland and France should fall
  //   near the historical dates).
  // China: 8 years (user requirement: a stronger Chinese army so that the Republic of China holds out longer; the
  // user picked 8 from these measurements, 20 seeds each). With 0.73 it capitulated in January 1940 in every seed (its
  // army was 3–4 against Japan's 18–26 there). 7 years → about December 1940 every time; 8 → about 60 % capitulate,
  // around September 1941, the others hold out to the end, Japan capitulating about 1945; 9–10 → China almost never
  // capitulates but wears Japan down, and Japan and Germany collapse in 1943–44.
  initialYearsByCountry: { GER: 5, ITA: 3.5, USA: 0.2, SOV: 9.03, UK: 0.5, FFR: 0.1, CHN: 8, IND: 2 },
  // USA and USSR: no army / navy production before their first war (user requirements).
  preWarGrowth: { USA: 0, SOV: 0 },
  // Tuned (search over 0.3–2 and caps 2/3/4/6): up to 6 states per front line per week (more on broad fronts).
  advanceRate: 1.87,
  advanceMax: 6,
  // User requirement (Poland and France should fall near the historical dates): the 1940 western line (Denmark, the
  // Low Countries and France together) advanced only ~2 states a week in total and France fell in August.
  // Design value: 15 edges, about one country's border.
  advanceBreadthEdges: 15,
  liberateToOriginalOwner: true,
  axisBWeeks: 156,
  // User requirement: condition B also needs Chongqing (China's capital) held by the Axis.
  axisBCapitals: ["CHN"],
  // User requirement: in the German-Soviet war the Axis must strike first. The USSR is numerically stronger on the
  // front in June 1941 (as it was historically) and attacked at once; historically surprise and unreadiness let
  // Germany take the initiative. Design values: 40 % strength in the first week, back to full after 8 weeks.
  surprise: { SOV: { weeks: 8, factor: 0.4 } },
  // User requirement: China's large initial army (initialYearsByCountry.CHN) was too strong early on; it fights at
  // half strength at the start, recovering linearly until the end of 1944 (poor equipment and training, improved by
  // Allied aid).
  strengthFactors: { CHN: [["1939-09-01", 0.5], ["1944-12-31", 1]] },
  // User requirement (Japan too weak in the Pacific War): Japan fights the Western Allies at 2.5× strength until
  // the end of 1942 (surprise, training, air and naval superiority, as in its 1941–42 advance), back to normal by the
  // end of 1943, and weaker from mid-1944 to half strength in March 1945 (lost air and sea control, supply cut off).
  // Re-tuned after the Americas landing ban (user requirement: Singapore falls in more than half the runs). Measured
  // (12 seeds): 2× → Singapore falls in 3, 2.5× → 9 (Batavia 10, Rangoon 5; the war ends 1945-05 – 1947-01), 3× → 12
  // but up to 1948. Chosen 2.5×.
  matchupStrength: {
    JAP: {
      against: ["USA", "UK", "NEI", "AST", "NZL", "CAN", "FFR", "SAF", "HOL"],
      factor: [["1942-12-31", 2.5], ["1943-12-31", 1], ["1944-06-01", 1], ["1945-03-01", 0.5]],
    },
    // User requirement: with Germany meeting the western landings at parity (holdAgainst), Germany still capitulates
    // in the first half of 1945. From D-Day the Western Allies fight Germany at 1.3×, rising to 2× in March 1945, 8× in
    // June and 16× in October (air superiority, materiel; the late values end the few runs where the front stalls).
    // Measured (20 seeds, with landingStrength and the stronger German Barbarossa below): Germany capitulates median
    // 1945-04-20, 10–90 % 1944-12-04 – 1945-05-28. Before Barbarossa was strengthened 1.8× / 3× gave about the same
    // (median 1945-04-02); with it, they gave 1944-12. Without both factors: median 1946-10, two runs never.
    ...Object.fromEntries(["USA", "UK", "CAN", "FFR"].map((t) => [t, {
      against: ["GER"],
      factor: [["1944-06-05", 1], ["1944-06-06", 1.3], ["1945-03-01", 2], ["1945-06-01", 8], ["1945-10-01", 16]] as [string, number][],
    }])),
    // User requirement: Germany is stronger early in the war against the USSR; its first offensive ends just short of
    // Moscow before winter (with defenceZones). 2.4× at Barbarossa, back to normal by mid-October 1941 (2× until
    // British India became its own country; the front then stopped about 270 km from Moscow instead of 180).
    GER: { against: ["SOV"], factor: [["1941-06-21", 1], ["1941-06-22", 2.4], ["1941-10-15", 1]] },
  },
  // User requirement: Free France (FFR) fights on after France capitulates; its seat is Brazzaville until Paris is
  // retaken (its colonies join on the historical dates, scenario.transfers).
  successors: { FRA: { tag: "FFR", seat: [15.27, -4.27] } },

  // Navy (user requirements): 8 years of preparation, USA 2; landing needs 70 % of the enemy navy in
  // the zone. preWarGrowth also applies to the navy (USA builds no ships before entering the war).
  navyInitialYears: 8,
  navyInitialYearsByCountry: { USA: 2 },
  navyPerFleet: 5,
  maxFleets: 6,
  // Tuned (search over 0.1–0.5 and 0.05–0.3).
  fleetBattleChance: 0.49,
  fleetBattleLossRate: 0.18,
  navalSuperiority: 0.7,
  // User requirement (after Italy landed in Cornwall from Malta over the 2225 km "UK - Malta" convoy route, judged
  // only in the Western Mediterranean): long routes also need control at both ends. Design value: 1500 km, the
  // longest automatic routes are shorter, the long manual convoy/ocean routes longer.
  longRouteKm: 1500,
  // User requirement: Germany's attack on Norway (1940) does not depend on naval power.
  landingWithoutNavy: { GER: ["NOR"] },
  // User requirement (Japan too weak in the Pacific War): the Japanese navy stays in the Pacific and the Indian Ocean
  // (it had followed Germany's fronts into the North Sea and the Channel and lost a third of its fleet there in 1942),
  // and the Chinese coast attracts it only a tenth as much (China has no navy; its routes across the East China Sea
  // had kept two thirds of the fleet at home, leaving about 25 for the southern advance).
  fleetZones: {
    JAP: [
      "アラビア海", "ベンガル湾", "インド洋南部", "ジャワ海", "南シナ海", "東シナ海・黄海", "日本海", "オホーツク海",
      "フィリピン海", "中部太平洋", "ハワイ近海", "北太平洋", "米西海岸沖", "珊瑚海・ソロモン", "タスマン海", "南太平洋東部",
    ],
  },
  fleetEnemyWeights: { JAP: { CHN: 0.1 } },
  fleetBattleLogMin: 5,
  // User requirement: the end shows "○○人もの犠牲者を出した第二次世界大戦終結" with a historically plausible number.
  // WWII deaths are estimated at about 70–85 million including civilians; the median total combat losses of the
  // historical preset are about 2,014 (60 seeds, p10–p90 1,809–2,317), so 37,000 people per unit gives a median of
  // about 75 million (p10–p90 about 67–86 million).
  peoplePerLoss: 37000,

  secondsPerYear: 10,
  speedMin: 0.5,
  speedMax: 4,
};

export function makeConfig(overrides: Partial<SimConfig> = {}): SimConfig {
  if (overrides.stepDays !== undefined && overrides.stepDays !== 3.5 && overrides.stepDays !== 7) {
    throw new Error("stepDays must be 3.5 or 7");
  }
  return { ...DEFAULT_CONFIG, ...overrides };
}
