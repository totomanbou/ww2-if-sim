// Public API of the headless simulation engine (no DOM dependencies).
export * from "./types";
export * from "./config";
export { MASK, maskFactor, type MaskTable } from "./mask";
export { createSimulation, type InitOptions } from "./init";
export { step, runToEnd } from "./engine";
export { effectiveIndustry, yearlyGrowth } from "./growth";
export { computeFronts, invulnerableActive } from "./combat";
export { lostShare } from "./capitulation";
export { fleetPower, navyTotals, hasSuperiority } from "./navy";
export { ALL_CITIES, CITY_NAMES, alliedVictoryCountries, capitalHeldByAxis, cityHolder, citySide, isFallen, victoryTargets } from "./victory";
export { FACTION_WAR_NOTE, applyFactions, setFaction } from "./factions";
export { importantCityFallen } from "./importantCities";
export { CAPITAL_NAMES, capitalName } from "./capitals";
export { DAY_MS, DEFAULT_STEP_DAYS, formatDate, parseDate, perStepProbability, stepWeeks, tickTime } from "./date";
export {
  SCENARIO_FORMAT, INDUSTRY_MAX, cloneScenario, entryDates, warsOf, capitalOf, clampIndustry, clampShipbuilding, clampStability,
  toScenarioFile, applyScenarioFile, type ScenarioFile,
} from "./scenario";
