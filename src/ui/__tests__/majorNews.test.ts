import { describe, expect, it } from "vitest";
import type { EventType, Scenario, SimEvent } from "../../sim/types";
import { MAJOR_COUNTRIES, MajorNewsQueue, majorHeadline } from "../majorNews";
import { NewsQueue } from "../newsQueue";

const scenario: Scenario = { name: "test", seed: 1, wars: [], countries: {
  FRA: { name: "フランス", formalName: "フランス共和国", faction: "allies", industry: 1, shipbuilding: 0, stability: 1, color: "#fff" },
  GER: { name: "ドイツ", formalName: "ドイツ国", faction: "axis", industry: 1, shipbuilding: 0, stability: 1, color: "#fff" },
  FFR: { name: "自由フランス", faction: "allies", industry: 1, shipbuilding: 0, stability: 1, color: "#fff" },
} };
const event = (type: EventType, countries: string[]): SimEvent => ({ type, countries, tick: 1, date: "1940-06-21", text: "" });

describe("major news selection", () => {
  it("uses exactly the eight requested countries, independent of their IF production", () => {
    expect([...MAJOR_COUNTRIES].sort()).toEqual(["SOV", "GER", "ITA", "USA", "UK", "FRA", "JAP", "CHN"].sort());
  });
  it.each([...MAJOR_COUNTRIES])("includes all three important events for %s", (tag) => {
    for (const type of ["capitulation", "capitalFall", "capitalRecapture"] as const) {
      expect(majorHeadline(event(type, [tag, "FFR"]), scenario)).not.toBeNull();
    }
  });
  it.each(["POL", "NEI", "FFR", "UNKNOWN"])("does not include a minor country's event just because the other country is major: %s", (tag) => {
    for (const type of ["capitulation", "capitalFall", "capitalRecapture"] as const) {
      expect(majorHeadline(event(type, [tag, "GER"]), scenario)).toBeNull();
    }
  });
  it.each(["war", "cityFall", "cityRecapture", "revival", "transfer", "fleetBattle", "victory", "stalemate"] as const)("excludes %s from popups", (type) => {
    expect(majorHeadline(event(type, ["FRA", "GER"]), scenario)).toBeNull();
  });
  it("names the affected country and captor/liberator clearly", () => {
    expect(majorHeadline(event("capitulation", ["FRA", "GER"]), scenario)).toBe("フランス共和国がドイツ国に降伏");
    expect(majorHeadline(event("capitalFall", ["FRA", "GER"]), scenario)).toBe("ドイツ国がパリを占領");
    expect(majorHeadline(event("capitalRecapture", ["FRA", "FFR"]), scenario)).toBe("自由フランスがパリを奪還");
    expect(majorHeadline(event("capitulation", ["FRA"]), scenario)).toBe("フランス共和国が降伏");
    expect(majorHeadline(event("capitalFall", []), scenario)).toBeNull();
  });
});

describe("three-second major popup queue", () => {
  const fall = { date: "1940-06-21", text: "フランスの首都が陥落" };
  const surrender = { date: "1940-06-21", text: "フランスが降伏" };

  it("expires and hides the last popup at three real seconds", () => {
    const queue = new MajorNewsQueue();
    expect(queue.current).toBeUndefined();
    queue.add(fall, 100);
    expect(queue.update(3099)).toBe(false);
    expect(queue.current).toEqual(fall);
    expect(queue.update(3100)).toBe(true);
    expect(queue.current).toBeUndefined();
    expect(queue.update(10_000)).toBe(false);
  });
  it("gives each simultaneous news item its own full three seconds", () => {
    const queue = new MajorNewsQueue();
    queue.add(fall, 0); queue.add(surrender, 0);
    expect(queue.current).toEqual(fall); expect(queue.pending).toBe(1);
    expect(queue.update(2999)).toBe(false);
    queue.update(3000);
    expect(queue.current).toEqual(surrender); expect(queue.pending).toBe(0);
    expect(queue.update(5999)).toBe(false);
    queue.update(6000);
    expect(queue.current).toBeUndefined();
  });
  it("does not skip waiting popups after a background tab or long frame", () => {
    const queue = new MajorNewsQueue();
    queue.add(fall, 0); queue.add(surrender, 0);
    queue.update(60_000);
    expect(queue.current).toEqual(surrender);
    expect(queue.update(60_001)).toBe(false);
    queue.update(63_000);
    expect(queue.current).toBeUndefined();
  });
  it("starts a newly arriving popup immediately after the previous queue has emptied", () => {
    const queue = new MajorNewsQueue();
    queue.add(fall, 0); queue.update(3000);
    queue.add(surrender, 20_000);
    expect(queue.current).toEqual(surrender);
    expect(queue.update(22_999)).toBe(false);
    queue.update(23_000);
    expect(queue.current).toBeUndefined();
  });
  it("is independent of the ordinary 0.1-second ticker", () => {
    const normal = new NewsQueue(), major = new MajorNewsQueue();
    normal.add(fall, 0); normal.add(surrender, 0); major.add(fall, 0); major.add(surrender, 0);
    normal.update(100); major.update(100);
    expect(normal.current).toEqual(surrender);
    expect(major.current).toEqual(fall);
    major.update(3000);
    expect(major.current).toEqual(surrender);
  });
});
