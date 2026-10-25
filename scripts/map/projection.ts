import { geoMercator, geoNaturalEarth1, type GeoProjection } from "d3-geo";
import { LAT_BOT, LAT_TOP } from "./grid";

/**
 * The map's projection: Mercator (user requirement: its straight east and west edges let the map wrap east–west
 * without gaps; the simulation uses longitudes and latitudes, not map units, so it is unaffected). x runs from
 * 0 at 180°W to `width` at 180°E, y from 0 at LAT_TOP (84°N) down to the height at LAT_BOT (56°S).
 */
export const PROJECTION_NAME = "Mercator";

export function mapProjection(width: number, name = PROJECTION_NAME): GeoProjection {
  if (!Number.isFinite(width) || width <= 0) throw new Error(`Invalid map width: ${width}`);
  // Keep legacy maps readable by maintenance tools; new builds always use Mercator.
  if (name !== PROJECTION_NAME && name !== "NaturalEarth1") throw new Error(`Unsupported map projection: ${name}`);
  const p = name === "NaturalEarth1"
    ? geoNaturalEarth1().fitWidth(width, { type: "Sphere" })
    : geoMercator().scale(width / (2 * Math.PI)).translate([width / 2, 0]);
  const yTop = p([0, LAT_TOP])![1];
  return p.translate([p.translate()[0], p.translate()[1] - yTop]);
}

/** Map height in map units for a width (from LAT_TOP to LAT_BOT). */
export function mapHeight(width: number): number {
  return Math.ceil(mapProjection(width)([0, LAT_BOT])![1]);
}
