import { capitalName } from "./capitals";
import type { Scenario, SimEvent } from "./types";
import { CITY_NAMES } from "./victory";

export function countryNewsName(scenario: Scenario, tag: string): string {
  const country = scenario.countries[tag];
  return country?.formalName ?? country?.name ?? tag;
}

export function occupationText(actor: string, city: string, recaptured: boolean): string {
  return `${actor}が${city}を${recaptured ? "奪還" : "占領"}`;
}

/** One wording for popup, ticker, event log and results, using the fixed city's name. */
export function cityEventText(event: SimEvent, scenario: Scenario): string | null {
  const capital = event.type === "capitalFall" || event.type === "capitalRecapture";
  const city = event.type === "cityFall" || event.type === "cityRecapture";
  if (!capital && !city) return null;
  const actor = event.countries[capital ? 1 : 0];
  const name = capital ? capitalName(event.countries[0])
    : event.cityName ?? (event.city ? CITY_NAMES[event.city] : undefined);
  if (!actor || !name) return null;
  return occupationText(countryNewsName(scenario, actor), name,
    event.type === "capitalRecapture" || event.type === "cityRecapture");
}
