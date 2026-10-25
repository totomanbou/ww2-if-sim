import type { Scenario, SimEvent, SimState } from "../sim";
import { cityEventText } from "../sim/newsText";

/** How many country names a headline lists before "ほかNか国". */
const MAX_NAMES = 3;

/** Country name for headlines: the preset's formal name (大日本帝国) or its usual name. */
function newsName(scenario: Scenario, tag: string): string {
  const c = scenario.countries[tag];
  return c?.formalName ?? c?.name ?? tag;
}

/** "A・B・C", or "A・Bほか3か国" for more than MAX_NAMES; larger countries (army production) first. */
function nameList(scenario: Scenario, tags: string[]): string {
  const size = (t: string) => scenario.countries[t]?.industry ?? 0;
  const names = [...tags].sort((a, b) => size(b) - size(a)).map((t) => newsName(scenario, t));
  if (names.length <= MAX_NAMES) return names.join("・");
  return `${names.slice(0, MAX_NAMES - 1).join("・")}ほか${names.length - MAX_NAMES + 1}か国`;
}

/**
 * News headline for an event, or null if the event is not news: war declarations
 * ("【速報】大日本帝国がアメリカ合衆国・オランダ王国ほか6か国に宣戦布告") and capitulations
 * ("【速報】フランス共和国がドイツ国に降伏"), and city captures / liberations.
 */
export function headline(e: SimEvent, scenario: Scenario): string | null {
  if (e.type === "war") {
    const split = e.split ?? 1;
    const att = e.countries.slice(0, split), def = e.countries.slice(split);
    if (!att.length || !def.length) return null;
    return `【速報】${nameList(scenario, att)}が${nameList(scenario, def)}に宣戦布告`;
  }
  if (e.type === "capitulation") {
    const [c, to] = e.countries;
    if (to && e.occupied) return `【速報】${newsName(scenario, c)}が降伏 ${newsName(scenario, to)}が残る領土を占領`;
    return to ? `【速報】${newsName(scenario, c)}が${newsName(scenario, to)}に降伏` : `【速報】${newsName(scenario, c)}が降伏`;
  }
  if (e.type === "cityFall" || e.type === "cityRecapture") {
    const text = cityEventText(e, scenario);
    return text ? `【速報】${text}` : null;
  }
  return null;
}

/** Military deaths of both sides: army and navy combat losses converted to people (config.peoplePerArmyLoss / NavyLoss). */
export function deathToll(sim: SimState): number {
  const { axis, allies } = sim.losses;
  return (axis.army + allies.army) * sim.config.peoplePerArmyLoss + (axis.navy + allies.navy) * sim.config.peoplePerNavyLoss;
}

/** People in 万 rounded to 3 significant digits: 74,520,000 → "約7,450万人". */
export function formatPeople(n: number): string {
  const man = n / 10_000;
  const digits = Math.max(0, Math.floor(Math.log10(Math.max(1, man))) - 2);
  const rounded = Math.round(man / 10 ** digits) * 10 ** digits;
  return `約${rounded.toLocaleString("ja-JP")}万人`;
}

/** The closing headline: "約7,450万人もの犠牲者を出した第二次世界大戦終結". */
export function endHeadline(sim: SimState): string {
  return `${formatPeople(deathToll(sim))}もの犠牲者を出した第二次世界大戦終結`;
}
