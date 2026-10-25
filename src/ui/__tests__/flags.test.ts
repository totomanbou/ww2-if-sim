import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flagSvg } from "../flags";

const preset = JSON.parse(readFileSync("data/presets/historical.json", "utf8")) as { countries: Record<string, unknown> };
const tags = Object.keys(preset.countries);

describe("flagSvg", () => {
  it("covers the preset's countries", () => {
    expect(tags.length).toBeGreaterThan(0);
  });

  it.each(tags)("%s returns an svg with the standard viewBox", (tag) => {
    const svg = flagSvg(tag);
    expect(svg).not.toBeNull();
    expect(svg!.startsWith("<svg")).toBe(true);
    expect(svg).toContain('viewBox="0 0 30 20"');
    expect(svg!.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("uses the requested height with a 3:2 width, 12 px by default", () => {
    expect(flagSvg("FRA")).toContain('width="18" height="12"');
    expect(flagSvg("FRA", 16)).toContain('width="24" height="16"');
  });

  it("returns null for an unknown tag", () => {
    expect(flagSvg("XXX")).toBeNull();
    expect(flagSvg("toString")).toBeNull();
  });

  it("draws Germany as a plain black-white-red tricolour of rects", () => {
    const svg = flagSvg("GER")!;
    for (const c of ["#000000", "#ffffff", "#dd0000"]) expect(svg).toContain(c);
    expect(svg).not.toContain("<path");
    expect(svg).not.toContain("<polygon");
  });
});
