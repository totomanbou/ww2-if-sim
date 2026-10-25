import { FACTION_COLORS } from "../data";
import type { MapMarker } from "../render/mapRenderer";
import { CITY_NAMES, importantCityFallen, isFallen, type Scenario, type SimState } from "../sim";
import type { MapData, VictoryCity } from "../sim/mapTypes";

/** Shared by setup, observation and results. Victory cities retain their independent rules and symbols. */
export function cityMarkers(map: MapData, scenario: Scenario, sim?: SimState): MapMarker[] {
  const ring = (state: number) => {
    const faction = sim ? sim.faction[sim.owner[state]] : scenario.countries[map.states[state].owner]?.faction;
    return faction === "axis" || faction === "allies" ? FACTION_COLORS[faction] : "#000";
  };
  return [
    ...(Object.keys(CITY_NAMES) as VictoryCity[]).map((city) => ({
      state: map.cities[city], label: CITY_NAMES[city],
      color: sim && isFallen(sim, city) ? "#ffd400" : "#ffffff",
      ring: ring(map.cities[city]), labelBelow: city === "Paris",
    })),
    ...(map.importantCities ?? []).map((city, i) => ({
      state: city.state, at: city.position, label: city.name, kind: "important" as const,
      color: sim && importantCityFallen(sim, i) ? "#ffd400" : "#ffffff", ring: ring(city.state),
    })),
  ];
}
