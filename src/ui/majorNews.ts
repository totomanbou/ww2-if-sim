import type { Scenario, SimEvent } from "../sim/types";
import { headline } from "./news";
import type { NewsItem } from "./newsQueue";
import { cityEventText } from "../sim/newsText";

/** Fixed country tags: changing production in the IF setup does not change which countries are major. */
export const MAJOR_COUNTRIES = new Set(["SOV", "GER", "ITA", "USA", "UK", "FRA", "JAP", "CHN"]);

export function majorHeadline(event: SimEvent, scenario: Scenario): string | null {
  const [country] = event.countries;
  if (!MAJOR_COUNTRIES.has(country)) return null;
  if (event.type === "capitulation") return headline(event, scenario)!.replace(/^【速報】/, "");
  if (event.type === "capitalFall" || event.type === "capitalRecapture") return cityEventText(event, scenario);
  return null;
}

/** Independent from the 0.1-second ticker. Each popup expires after three real seconds. */
export class MajorNewsQueue {
  readonly durationMs = 3000;
  current: NewsItem | undefined;
  private waiting: NewsItem[] = [];
  private shownAt = 0;
  get pending(): number { return this.waiting.length; }

  add(item: NewsItem, now: number): void {
    if (this.current) this.waiting.push(item);
    else { this.current = item; this.shownAt = now; }
  }

  update(now: number): boolean {
    if (!this.current || now - this.shownAt < this.durationMs) return false;
    this.current = this.waiting.shift();
    this.shownAt = now;
    return true;
  }
}
