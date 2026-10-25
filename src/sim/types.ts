import type { SimConfig } from "./config";
import type { MaskTable } from "./mask";
import type { ImportantCity, VictoryCity } from "./mapTypes";
import type { Rng } from "./rng";

export type Faction = "axis" | "allies" | "neutral";

/** The part of data/map.json the engine needs (geometry is not used). */
export interface SimMap {
  /** lonlat: state centre (used for the distance factor of army allocation; missing = distance 0). */
  /** formerOwner: the country a 1939 border change took the state from (e.g. Japanese-occupied China → CHN). */
  states: { owner: string; core: boolean; lonlat?: [number, number]; formerOwner?: string }[];
  landAdj: number[][];
  /** zone: sea zone the route runs through (-1 or missing = none; no landing possible). */
  seaRoutes: { a: number; b: number; zone?: number; km?: number }[];
  /** Sea zones with their neighbours (fleet movement). Missing = no zones. */
  seaZones?: { name: string; neighbors: number[] }[];
  cities: Record<VictoryCity, number>;
  importantCities?: ImportantCity[];
  /** Terrain difficulty per state (0 easy, 1 normal, 2 hard). Missing = all normal. */
  terrain?: number[];
  countries: Record<string, { defaultCapital: number }>;
}

export interface CountrySetup {
  name: string;
  /** Formal name for news headlines (e.g. 大日本帝国); `name` if missing. Fixed by the preset. */
  formalName?: string;
  /**
   * Country whose faction this one follows when the faction is changed in the setup (user requirement: colonies
   * follow their home country): the Dutch East Indies (HOL), the British dominions (UK) and Free France (FRA).
   * It can still be changed on its own afterwards. Has no effect in the engine.
   */
  overlord?: string;
  color: string;
  /** Editable in the setup; war declarations follow it (applyFactions). */
  faction: Faction;
  /** Army production (shown as 陸軍生産力), relative index (USA = 100). Editable. */
  industry: number;
  /** Naval production (shown as 海軍生産力): the navy grows by shipbuilding × stability per year. Editable. */
  shipbuilding: number;
  /**
   * Naval power at the start (the 1939 fleet; set by the preset, not editable). Missing: shipbuilding × stability ×
   * config.navyInitialYears (navyInitialYearsByCountry).
   */
  navy?: number;
  /** 0.0–1.0. Editable. */
  stability: number;
}

export interface WarDeclaration {
  /** ISO date; the war starts on the first tick on or after this date. */
  date: string;
  /** Every country in `a` goes to war with every country in `b`. */
  a: string[];
  b: string[];
  note?: string;
}

export interface Scenario {
  name: string;
  seed: number;
  countries: Record<string, CountrySetup>;
  /** Fixed by the preset (not editable). */
  wars: WarDeclaration[];
  /** Per-state flags keyed by state id (not editable). */
  stateOverrides?: Record<string, { invulnerable?: boolean }>;
  /** Landing (sea-only attack) restrictions (not editable). */
  landingRestrictions?: LandingRestriction[];
  /** Scheduled hand-overs of a capitulated country's remaining territory, e.g. French colonies to Free France. */
  transfers?: Transfer[];
  /** News headline shown when the observation starts (the situation on the start date). */
  openingNews?: string;
}

/**
 * On `date` (or later, once `from` has capitulated), the states still owned by `from` that are among its original
 * states and whose centre lies in one of `boxes` ([west, south, east, north]) go to `to`.
 */
export interface Transfer {
  date: string;
  from: string;
  to: string;
  name: string;
  boxes: [number, number, number, number][];
  /** News text (default: "<name>が<to>に合流(n州)"), e.g. for an occupation rather than a colony changing sides. */
  text?: string;
}

/**
 * Sea-only attacks on the protected states are blocked while any state in `region` is held by a
 * country of faction `blockedWhileHeldBy`. Protected states: `protect` if given, otherwise the
 * defender's original states (homeland only with coreOnly).
 */
export interface LandingRestriction {
  defender: string;
  coreOnly: boolean;
  protect?: number[];
  blockedWhileHeldBy: Faction;
  region: number[];
  note?: string;
}

/** A naval unit. Its strength counts towards its country's naval power in its zone. */
export interface Fleet {
  country: number;
  zone: number;
  strength: number;
  /** Zone it is heading to (moves one zone per week). */
  target: number;
  /** Fractional travel time accumulated toward the next one-week zone crossing. */
  moveWeeks?: number;
}

export type EventType = "war" | "capitalFall" | "capitalRecapture" | "capitulation" | "revival" | "transfer" | "cityFall" | "cityRecapture" | "fleetBattle" | "victory" | "stalemate";

export interface SimEvent {
  tick: number;
  date: string;
  type: EventType;
  /** Country tags involved (meaning depends on type). */
  countries: string[];
  city?: VictoryCity;
  /** Important city news is separate from the seven victory cities. */
  importantCity?: string;
  cityName?: string;
  /** Sea zone (fleetBattle). */
  zone?: number;
  /** war: the first `split` countries declared war on the rest. */
  split?: number;
  /** capitulation: the second country is an ally that occupied the remaining territory (config.capitulationOccupier). */
  occupied?: boolean;
  text: string;
}

export type VictoryCondition = "axisA" | "axisB" | "allies";

export interface SimResult {
  winner: "axis" | "allies" | "stalemate";
  condition: VictoryCondition | null;
  endTick: number;
  endDate: string;
}

/** One sample per tick for the faction charts. */
export interface FactionSample {
  tick: number;
  /** Army (陸軍力). */
  military: { axis: number; allies: number };
  navy: { axis: number; allies: number };
  industry: { axis: number; allies: number };
}

export interface SimState {
  readonly config: SimConfig;
  readonly mask: MaskTable;
  readonly scenario: Scenario;
  /** Seed this run was started with. */
  readonly seed: number;
  // ---- static (fixed after init) ----
  readonly tags: string[];
  readonly names: string[];
  readonly faction: Faction[];
  readonly industry: Float64Array;
  readonly shipbuilding: Float64Array;
  readonly stability: Float64Array;
  readonly capital: Int32Array;
  readonly importantCities: ImportantCity[];
  importantCityFallen: Uint8Array;
  /** State centres as lon, lat pairs (NaN when the map has none). */
  readonly stateLonLat: Float64Array;
  readonly nStates: number;
  /** Neighbour lists in CSR form: neighbours of s are nb[off[s]..off[s+1]). */
  readonly landOff: Int32Array;
  readonly landNb: Int32Array;
  readonly seaOff: Int32Array;
  readonly seaNb: Int32Array;
  /** Sea zone of each seaNb entry (-1 = none). */
  readonly seaZone: Int16Array;
  /** Sea zones: names, neighbours, and all-pairs hop distances (nZ × nZ, 255 = unreachable). */
  readonly zoneNames: string[];
  readonly zoneNeighbors: number[][];
  readonly zoneDist: Uint8Array;
  /** Home zone per country (-1 = none: no fleets). */
  readonly homeZone: Int16Array;
  /** Sea route list (for the fleet AI): endpoints and zone. */
  readonly routeA: Int32Array;
  readonly routeB: Int32Array;
  readonly routeZone: Int16Array;
  /** Every adjacent state pair (land or sea route) once, as parallel arrays (for country connectivity). */
  readonly adjA: Int32Array;
  readonly adjB: Int32Array;
  /** Per sea-route entry (parallel to seaNb): the state it starts from, and the route's length in km (0 if unknown). */
  readonly seaFrom: Int32Array;
  readonly seaKm: Float32Array;
  /**
   * Port zones per state (CSR: portOff / portZone): the zones of its routes up to config.longRouteKm, i.e. the
   * waters around it. A long route needs naval superiority in these at both ends as well (navy.routeControlled).
   */
  readonly portOff: Int32Array;
  readonly portZone: Int16Array;
  /** Every land-border pair once (s < t), as parallel arrays. */
  readonly landPairA: Int32Array;
  readonly landPairB: Int32Array;
  /** Land mass of each state (connected over land borders only), for overseas fronts in army allocation. */
  readonly landMass: Int32Array;
  /** Compiled landing restrictions: protected target states and the region that must be cleared. */
  readonly restrictions: { protects: Uint8Array; region: Int32Array; heldBy: Faction }[];
  readonly origOwner: Uint16Array;
  /** Whose land a state is (config.slowAdvanceLand): its former owner if the map gives one, else origOwner. */
  readonly landOf: Uint16Array;
  /** Terrain difficulty per state: 0 easy, 1 normal, 2 hard (map.terrain; all normal without it). */
  readonly terrain: Uint8Array;
  /** Industry weight of each state within its original owner (sums to 1 per country). */
  readonly weight: Float64Array;
  /** Number of original states per country. */
  readonly origCount: Int32Array;
  readonly invulnerable: Uint8Array;
  /** 1 = homeland state of its original owner, 0 = colony / mandate / occupied territory (map `core`). */
  readonly core: Uint8Array;
  readonly cities: Record<VictoryCity, number>;
  readonly startMs: number;
  readonly endMs: number;
  // ---- dynamic ----
  tick: number;
  owner: Uint16Array;
  /** Naval units (removed when their country capitulates). */
  fleets: Fleet[];
  /** Set once a state's owner has changed; disables `invulnerable` for good. */
  invLost: Uint8Array;
  /** Army (陸軍力) per country. */
  military: Float64Array;
  /** nC × nC matrix, 1 = at war. */
  atWar: Uint8Array;
  capitulated: Uint8Array;
  capitalHeld: Uint8Array;
  /** Notification-only enemy occupation flags; retained when a country capitulates or revives. */
  capitalOccupied: Uint8Array;
  /**
   * 1 while a revived country has not yet got its capital back; it cannot capitulate again until then
   * (it was revived by an ally liberating one of its states after it had capitulated).
   */
  revivedAwaitingCapital: Uint8Array;
  /**
   * facing[c × nC + e]: army of country e this week on the front lines where c holds front states and e is at war
   * with c (set by combat.resolveCombat; used to choose who receives a capitulating country's territory).
   */
  facing: Float64Array;
  /**
   * Display only (observe screen): the land army of each country on each front line this step (set by
   * combat.resolveCombat), with the mean lon/lat of the line's front states. Countries with no army there are left out.
   */
  frontArmies: FrontArmy[];
  /** Entries of config.cityFallReinforcements already given (1 = done). */
  reinforcementsDone: Uint8Array;
  /** Entries of config.warStartReinforcements already given (1 = done). */
  warStartDone: Uint8Array;
  /** Tick when a country was attacked by surprise (config.surprise), -1 if never. */
  surpriseStart: Int32Array;
  /** Scenario transfers sorted by date, and 1 for each one already applied. */
  readonly transfers: Transfer[];
  transferDone: Uint8Array;
  /**
   * Troops at the fronts: country → map cell → share of its army deployed there ("allocated" mode).
   * Moves towards the allocation each week with a distance-based delay (combat.deployArmies).
   */
  deployed: Map<number, CellMap>;
  /** 1 once the country has entered its first war (used by config.preWarGrowth). */
  entered: Uint8Array;
  /** Index of the next war declaration (scenario.wars sorted by date). */
  nextWar: number;
  readonly wars: WarDeclaration[];
  axisBWeeks: number;
  cityFallen: Record<VictoryCity, boolean>;
  events: SimEvent[];
  history: FactionSample[];
  /** Cumulative combat losses per faction (army in land battles, navy in fleet battles). Capitulations not counted. */
  losses: { axis: { army: number; navy: number }; allies: { army: number; navy: number } };
  rng: Rng;
  result: SimResult | null;
}

/** Army share per transit map cell (a Map, or the typed-array CellShares the engine uses). */
export interface CellMap {
  get(cell: number): number | undefined;
  has(cell: number): boolean;
  readonly size: number;
  keys(): IterableIterator<number>;
  set(cell: number, v: number): unknown;
  delete(cell: number): boolean;
  [Symbol.iterator](): IterableIterator<[number, number]>;
}

/** One front line's armies for display (SimState.frontArmies). */
export interface FrontArmy {
  /** Geographic amphibious approach, when a line belongs to one separated landing theatre. */
  theatre?: string;
  /** Line id (smallest state id of the line). */
  line: number;
  lon: number;
  lat: number;
  /** [country index, army] pairs, largest first. */
  armies: [number, number][];
  /** Front states of the line (for naming it by region). */
  states: number[];
}
