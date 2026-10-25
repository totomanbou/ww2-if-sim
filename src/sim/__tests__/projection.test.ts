import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { geoNaturalEarth1 } from "d3-geo";
import { LAT_BOT, LAT_TOP } from "../../../scripts/map/grid";
import { makeStateLookup } from "../../../scripts/map/lookup";
import { mapHeight, mapProjection } from "../../../scripts/map/projection";
import { reprojectMap } from "../../../scripts/map/reproject";
import type { MapData } from "../mapTypes";

const width = 8000;
const legacyProjection = () => {
  const p = geoNaturalEarth1().fitWidth(width, { type: "Sphere" });
  const y = p([0, LAT_TOP])![1];
  return p.translate([p.translate()[0], p.translate()[1] - y]);
};

function legacyMap(): MapData {
  const p = legacyProjection();
  return {
    version: 1, projection: "NaturalEarth1", width, height: Math.ceil(p([0, LAT_BOT])![1]),
    states: [{ id: 0, owner: "A", core: true, areaKm2: 1234, coastal: true, lonlat: [20, 50],
      center: p([20, 50]) as [number, number],
      rings: [[[19, 49], [21, 49], [21, 51], [19, 51]].flatMap((ll) => p(ll as [number, number])!)],
    }],
    countries: { A: { stateCount: 1, defaultCapital: 0 } },
    cities: { London: 0, Moscow: 0, Honolulu: 0, Paris: 0, Rome: 0, Berlin: 0, Tokyo: 0 },
    importantCities: [{ id: "city", name: "都市", home: "A", state: 0, lonlat: [20, 50], position: [0, 0] }],
    landAdj: [[]], terrain: [2], seaRoutes: [{ a: 0, b: 0, km: 124, src: "manual", zone: 0 }],
    seaZones: [{ id: 0, name: "海域", neighbors: [], lonlat: [30, 40], center: [0, 0] }],
  };
}

function simulationData(map: MapData) {
  const { projection: _p, height: _h, states, importantCities, seaZones, ...rest } = map;
  return { ...rest,
    states: states.map(({ center: _c, rings: _r, ...state }) => state),
    importantCities: importantCities?.map(({ position: _p, ...city }) => city),
    seaZones: seaZones.map(({ center: _c, ...zone }) => zone),
  };
}

describe("display-only Mercator projection", () => {
  it("matches the Mercator formula and round-trips geographic coordinates", () => {
    const p = mapProjection(width);
    for (const ll of [[0, 0], [20, 50], [135, -30], [-150, 70]] as [number, number][]) {
      const xy = p(ll)!;
      const y = (lat: number) => -width / (2 * Math.PI) * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
      expect(xy[0]).toBeCloseTo(width * (ll[0] + 180) / 360, 8);
      expect(xy[1]).toBeCloseTo(y(ll[1]) - y(LAT_TOP), 8);
      const back = p.invert!(xy)!;
      expect(back[0]).toBeCloseTo(ll[0], 8);
      expect(back[1]).toBeCloseTo(ll[1], 8);
    }
  });

  it("keeps both date-line edges straight and exactly one map width apart", () => {
    const p = mapProjection(width);
    for (const lat of [LAT_BOT, -30, 0, 50, LAT_TOP]) {
      expect(p([-180, lat])![0]).toBeCloseTo(0, 8);
      expect(p([180, lat])![0]).toBeCloseTo(width, 8);
      expect(p([-180, lat])![1]).toBeCloseTo(p([180, lat])![1], 8);
    }
    expect(p([0, LAT_TOP])![1]).toBeCloseTo(0, 8);
    expect(mapHeight(width)).toBe(Math.ceil(p([0, LAT_BOT])![1]));
  });

  it("reads legacy Natural Earth geometry using its original transform", () => {
    const old = legacyProjection(), p = mapProjection(width, "NaturalEarth1");
    for (const ll of [[0, 0], [20, 50], [-180, 84]] as [number, number][]) expect(p(ll)).toEqual(old(ll));
  });

  it("rejects unknown projections and invalid dimensions", () => {
    expect(() => mapProjection(width, "Unknown")).toThrow("Unsupported");
    for (const w of [0, -1, NaN, Infinity]) expect(() => mapProjection(w)).toThrow("Invalid");
  });

  it("preserves every non-display field and never mutates the input", () => {
    const old = legacyMap(), snapshot = structuredClone(old), map = reprojectMap(old);
    expect(old).toEqual(snapshot);
    expect(simulationData(map)).toEqual(simulationData(old));
    expect(map.states[0].rings).not.toEqual(old.states[0].rings);
    expect(map.projection).toBe("Mercator");
    expect(map.height).toBe(mapHeight(width));
  });

  it("uses the same projection for rings, state centres, cities, zones and point lookup", () => {
    const old = legacyMap(), map = reprojectMap(old), p = mapProjection(width);
    expect(makeStateLookup(old)(20, 50)).toBe(0);
    expect(makeStateLookup(map)(20, 50)).toBe(0);
    expect(map.states[0].center).toEqual(p([20, 50])!.map(Math.round));
    expect(map.importantCities![0].position).toEqual(p([20, 50])!.map(Math.round));
    expect(map.seaZones[0].center).toEqual(p([30, 40])!.map(Math.round));
  });

  it("is idempotent, avoiding cumulative distortion on repeated conversion", () => {
    const map = reprojectMap(legacyMap());
    expect(reprojectMap(map)).toEqual(map);
  });

  it("keeps rounded date-line vertices on their own edge instead of drawing across the world", () => {
    const old = legacyMap();
    old.states[0].rings = [[1017, 247, 1032, 235, 1036, 235], [6966, 235, 6968, 235, 6983, 247]];
    const map = reprojectMap(old);
    expect(map.states[0].rings[0][2]).toBe(0);
    expect(map.states[0].rings[1][2]).toBe(width);
    for (const ring of map.states[0].rings) {
      const xs = ring.filter((_, i) => i % 2 === 0);
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(10);
    }
  });

  it("ships finite Mercator geometry with correctly located important cities and fleets", () => {
    const map = JSON.parse(readFileSync(new URL("../../../data/map.json", import.meta.url), "utf8")) as MapData;
    expect(map.projection).toBe("Mercator");
    expect(map.height).toBe(mapHeight(map.width));
    const p = mapProjection(map.width);
    const invalid: { state: number; vertex: number }[] = [];
    for (const state of map.states) for (const ring of state.rings) {
      for (let i = 0; i < ring.length; i += 2) {
        const x = ring[i], y = ring[i + 1];
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > map.width || y < 0 || y > map.height ||
          Math.abs(x - ring[(i + 2) % ring.length]) >= map.width / 2) invalid.push({ state: state.id, vertex: i / 2 });
      }
    }
    expect(invalid).toEqual([]);
    for (const city of map.importantCities ?? []) expect(city.position).toEqual(p(city.lonlat)!.map(Math.round));
    for (const zone of map.seaZones) expect(zone.center).toEqual(p(zone.lonlat)!.map(Math.round));
  });
});
