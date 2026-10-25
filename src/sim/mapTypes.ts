/** Shape of data/map.json (produced by scripts/build-map.ts). */
export interface MapState {
  id: number;
  /** Country tag in September 1939. */
  owner: string;
  areaKm2: number;
  lonlat: [number, number];
  /** Projected centre in map units. */
  center: [number, number];
  coastal: boolean;
  /** Homeland (true) or colony / occupied / mandate territory (false) of the 1939 owner. */
  core: boolean;
  /** Rings as flat [x0, y0, x1, y1, ...] in map units; fill with even-odd. */
  rings: number[][];
}

export interface SeaRoute {
  a: number;
  b: number;
  km: number;
  src: "auto" | "manual";
  name?: string;
  /** Sea zone the route runs through (-1 = none, e.g. an inland lake). */
  zone: number;
}

export interface SeaZone {
  id: number;
  name: string;
  lonlat: [number, number];
  /** Projected representative point (fleet marker position). */
  center: [number, number];
  /** Adjacent zone ids. */
  neighbors: number[];
}

export type VictoryCity = "London" | "Moscow" | "Honolulu" | "Paris" | "Rome" | "Berlin" | "Tokyo";

/** A historical city for display and news; it never participates in victory checks. */
export interface ImportantCity {
  id: string;
  name: string;
  home: string;
  state: number;
  lonlat: [number, number];
  position: [number, number];
}

export interface MapData {
  version: number;
  projection: string;
  width: number;
  height: number;
  countries: Record<string, { stateCount: number; defaultCapital: number }>;
  cities: Record<VictoryCity, number>;
  importantCities?: ImportantCity[];
  /** Terrain difficulty per state id: 0 easy, 1 normal, 2 hard (scripts/map/terrain.ts). Missing → all normal. */
  terrain?: number[];
  states: MapState[];
  /** Land neighbours per state id. */
  landAdj: number[][];
  seaRoutes: SeaRoute[];
  seaZones: SeaZone[];
}
