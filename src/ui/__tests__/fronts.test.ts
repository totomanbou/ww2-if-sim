import { describe, expect, it } from "vitest";
import type { FrontArmy, SimState } from "../../sim";
import { frontRegionName, frontTitle, regionOf, visibleFronts } from "../fronts";

describe("visibleFronts", () => {
  const front = (line: number, army: number, theatre?: string): FrontArmy =>
    ({ line, lon: 0, lat: 0, states: [], armies: [[0, army]], theatre });

  it("keeps both landing approaches visible even when smaller than eight ground fronts", () => {
    const ground = Array.from({ length: 10 }, (_, i) => front(i, 100 - i));
    const france = front(10, 8, "フランス方面"), germany = front(11, 2, "ドイツ方面");
    const result = visibleFronts([...ground, france, germany]);
    expect(result).toHaveLength(8);
    expect(result).toContain(france); expect(result).toContain(germany);
    expect(result[0]).toBe(ground[0]);
    expect(result).not.toContain(ground[9]);
  });

  it("reserves one main entry per approach and keeps the remaining slots for large fronts", () => {
    const main = front(0, 30, "フランス方面"), small = front(1, 1, "フランス方面");
    const ground = Array.from({ length: 8 }, (_, i) => front(i + 2, 20 - i));
    const result = visibleFronts([small, ...ground, main]);
    expect(result[0]).toBe(main); expect(result).not.toContain(small);
    expect(result).toHaveLength(8);
  });

  it("still omits empty and negligible contacts", () => {
    expect(visibleFronts([front(0, 0, "ドイツ方面"), front(1, 0.1), front(2, 2)])).toEqual([front(2, 2)]);
  });
});

describe("German eastern front naming", () => {
  it("labels the Soviet advance into Berlin as the eastern front, rather than a western deployment", () => {
    const sim = { ...simWith([[13.4, 52.5]]), tags: ["SOV", "UK"] };
    const front: FrontArmy = { line: 0, lon: 13.4, lat: 52.5, states: [0], armies: [[0, 10]] };
    expect(frontTitle(sim, front)).toBe("東部戦線（ドイツ方面）");
    expect(frontTitle(sim, { ...front, armies: [[1, 10]] })).toBe("西部戦線");
    expect(frontTitle(sim, { ...front, theatre: "フランス方面" })).toBe("フランス方面上陸戦線");
  });
});

describe("regionOf", () => {
  it.each([
    [30, 52, "東部"],
    [30, 64, "北欧"],
    [24, 31, "北アフリカ"],
    [113, 30, "中国"],
    [-67, 78, "グリーンランド"],
    [0, 50, "西部"],
    [12, 42, "イタリア"],
    [20, 42, "バルカン"],
    [45, 30, "中東"],
    [37, 5, "東アフリカ"],
    [20, -20, "中央アフリカ"],
    [75, 25, "インド"],
    [95, 20, "ビルマ"],
    [105, 5, "東南アジア"],
    [150, 0, "太平洋"],
    [-150, 20, "太平洋"],
  ])("(%f, %f) is %s", (lon, lat, name) => {
    expect(regionOf(lon, lat)).toBe(name);
  });

  it("returns null outside every box", () => {
    expect(regionOf(0, -60)).toBeNull();
    expect(regionOf(-40, -10)).toBeNull();
    expect(regionOf(100, 80)).toBeNull();
  });

  it("the first matching box wins where boxes overlap", () => {
    // The 北欧 box is listed before 東部 / 西部: the shared edge latitude 60.5 belongs to 北欧.
    expect(regionOf(30, 60.5)).toBe("北欧");
    expect(regionOf(30, 60.4)).toBe("東部");
    // 北アフリカ comes before 中東 and 東アフリカ.
    expect(regionOf(33, 30)).toBe("北アフリカ");
    // イタリア before バルカン and 西部.
    expect(regionOf(10, 45)).toBe("イタリア");
    // バルカン before 東部.
    expect(regionOf(20, 44)).toBe("バルカン");
  });

  it("box edges are inclusive", () => {
    expect(regionOf(4, 60.5)).toBe("北欧");
    expect(regionOf(45, 75)).toBe("北欧");
  });
});

/** Minimal sim stand-in: only stateLonLat is read. */
function simWith(points: [number, number][]): SimState {
  const stateLonLat = new Float64Array(points.length * 2);
  points.forEach(([lon, lat], i) => stateLonLat.set([lon, lat], 2 * i));
  return { stateLonLat } as unknown as SimState;
}

describe("frontRegionName", () => {
  const east: [number, number] = [30, 52];
  const nafrica: [number, number] = [24, 31];
  const china: [number, number] = [113, 30];
  const nowhere: [number, number] = [0, -60];

  it("names a line after its single region", () => {
    expect(frontRegionName(simWith([east, east, east]), [0, 1, 2])).toBe("東部戦線");
  });

  it("returns null when no state lies in a region (or there are no states)", () => {
    expect(frontRegionName(simWith([nowhere, nowhere]), [0, 1])).toBeNull();
    expect(frontRegionName(simWith([east]), [])).toBeNull();
  });

  it("adds a second region holding at least 25 % of the states", () => {
    const sim = simWith([east, east, east, nafrica]); // 1 of 4 = 25 %
    expect(frontRegionName(sim, [0, 1, 2, 3])).toBe("東部・北アフリカ戦線");
  });

  it("omits a second region below 25 %", () => {
    const sim = simWith([east, east, east, east, nafrica]); // 1 of 5 = 20 %
    expect(frontRegionName(sim, [0, 1, 2, 3, 4])).toBe("東部戦線");
  });

  it("puts the majority region first", () => {
    const sim = simWith([nafrica, east, nafrica]);
    expect(frontRegionName(sim, [0, 1, 2])).toBe("北アフリカ・東部戦線");
  });

  it("counts states outside every region in the share denominator", () => {
    // 1 of 5 states is in 北アフリカ (20 % of all), so there is no second region even though it is half of the located ones.
    const sim = simWith([east, nafrica, nowhere, nowhere, nowhere]);
    expect(frontRegionName(sim, [0, 1, 2, 3, 4])).toBe("東部戦線");
  });

  it("names at most two regions", () => {
    const sim = simWith([east, east, nafrica, nafrica, china, china]);
    const name = frontRegionName(sim, [0, 1, 2, 3, 4, 5]);
    expect(name).not.toBeNull();
    expect(name!.split("・")).toHaveLength(2);
    expect(name!.endsWith("戦線")).toBe(true);
  });

  it("only looks at the listed states", () => {
    const sim = simWith([east, china, china]);
    expect(frontRegionName(sim, [0])).toBe("東部戦線");
    expect(frontRegionName(sim, [1, 2])).toBe("中国戦線");
  });

  it("treats a missing coordinate (NaN) as outside every region", () => {
    const sim = simWith([[NaN, NaN], east]);
    expect(frontRegionName(sim, [0, 1])).toBe("東部戦線");
    expect(frontRegionName(simWith([[NaN, NaN]]), [0])).toBeNull();
  });
});
