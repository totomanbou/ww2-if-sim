import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyTerrainOverrides, terrainRegionAt, terrainStateInRegion } from "../../../scripts/map/terrain-overrides";
import { polygonsOverlap } from "../../../scripts/map/polygon-intersection";
import { makeStateLookup } from "../../../scripts/map/lookup";
import { buildTerrain } from "../../../scripts/map/terrain";
import type { MapData, MapState } from "../mapTypes";

const state = (lon: number, lat: number, owner = "SOV", id = 0): MapState =>
  ({ id, owner, lonlat: [lon, lat], center: [lon, lat], rings: [], areaKm2: 1, coastal: false, core: true });

describe("explicit geographic terrain policies", () => {
  it.each([
    [30.52, 50.45, "Kyiv"], [24.03, 49.84, "Lviv"], [22.3, 48.62, "Uzhhorod"], [30.73, 46.48, "Odessa"],
    [36.23, 49.99, "Kharkiv"], [39.31, 48.57, "Luhansk"], [34.1, 44.95, "Simferopol"], [33.53, 44.6, "Sevastopol"],
  ])("includes all Ukraine at %s,%s (%s), regardless of 1939 ownership", (lon, lat) => {
    expect(terrainRegionAt("ukraine", lon, lat)).toBe(true);
    for (const owner of ["SOV", "POL", "ROM", "HUN"]) expect(applyTerrainOverrides({ states: [state(lon, lat, owner)] }, [2])).toEqual([0]);
  });

  it.each([[27.56, 53.9], [37.62, 55.75], [39.72, 47.23], [30.31, 59.94], [21.01, 52.23], [28.86, 47.01]])(
    "does not use a bounding rectangle that includes neighbouring places (%s,%s)", (lon, lat) => {
      expect(terrainRegionAt("ukraine", lon, lat)).toBe(false);
    });

  it("changes only easy Soviet hinterland, preserving normal/hard terrain and nearby Moscow/Finland", () => {
    const states = [state(40, 62), state(42, 63), state(44, 64), state(37.62, 55.75), state(34, 62, "FIN")];
    expect(applyTerrainOverrides({ states }, [0, 1, 2, 0, 0])).toEqual([2, 1, 2, 0, 0]);
  });

  it("is idempotent and changes no geography or original input array", () => {
    const map = { states: [state(40, 62), state(30.52, 50.45), state(37.62, 55.75)] };
    const snapshot = structuredClone(map), before = [0, 2, 1];
    const result = applyTerrainOverrides(map, before);
    expect(applyTerrainOverrides(map, result)).toEqual(result);
    expect(before).toEqual([0, 2, 1]); expect(map).toEqual(snapshot);
  });

  it("ships Ukraine as easy and keeps all current data consistent with the persistent rules", () => {
    const map = JSON.parse(readFileSync(new URL("../../../data/map.json", import.meta.url), "utf8")) as MapData;
    const ukraine = map.states.filter((s) => terrainStateInRegion("ukraine", map, s));
    expect(ukraine.length).toBeGreaterThan(20);
    expect(ukraine.filter((s) => map.terrain![s.id] !== 0).map((s) => s.id)).toEqual([]);
    expect(applyTerrainOverrides(map, map.terrain!)).toEqual(map.terrain);
  });

  it("includes the actual border state containing Izmail despite its centre lying in Romania", () => {
    const map = JSON.parse(readFileSync(new URL("../../../data/map.json", import.meta.url), "utf8")) as MapData;
    const s = map.states[makeStateLookup(map)(28.84, 45.35)];
    expect(terrainRegionAt("ukraine", ...s.lonlat)).toBe(false);
    expect(terrainStateInRegion("ukraine", map, s)).toBe(true);
    expect(map.terrain![s.id]).toBe(0);
  });

  it.skipIf(!existsSync(new URL("../../../data/raw/ne_10m_geography_regions_polys.geojson", import.meta.url)))(
    "reapplies the policies after a fresh natural-terrain calculation", () => {
      const map = { states: [state(30.52, 50.45, "POL", 0), state(40, 62, "SOV", 1), state(0, 0, "A", 2)],
        cities: { London: -1, Moscow: -1, Honolulu: -1, Paris: -1, Rome: -1, Berlin: -1, Tokyo: -1 }, countries: {} };
      expect(buildTerrain(map, () => null, () => -1).terrain).toEqual([0, 2, 1]);
    });
});

describe("state/boundary polygon overlap", () => {
  const square = (w: number, s: number, e: number, n: number) => [[w, s], [e, s], [e, n], [w, n]];
  it("finds a region enclosed by a state", () => {
    expect(polygonsOverlap([square(0, 0, 4, 4)], [square(1, 1, 2, 2)])).toBe(true);
  });
  it("finds crossing strips even when neither polygon has a vertex inside the other", () => {
    expect(polygonsOverlap([square(0, 1, 4, 2)], [square(1, 0, 2, 4)])).toBe(true);
  });
  it("rejects disjoint regions", () => {
    expect(polygonsOverlap([square(0, 0, 1, 1)], [square(2, 2, 3, 3)])).toBe(false);
  });
  it("does not count a polygon lying wholly in a state hole as land overlap", () => {
    expect(polygonsOverlap([square(0, 0, 5, 5), square(1, 1, 4, 4)], [square(2, 2, 3, 3)])).toBe(false);
  });
});
