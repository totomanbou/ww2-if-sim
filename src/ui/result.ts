import { FACTION_COLORS, FACTION_NAMES, formatDateJa } from "../data";
import { LineChart } from "../render/charts";
import { MapRenderer } from "../render/mapRenderer";
import { CITY_NAMES, DAY_MS, alliedVictoryCountries, capitalName, invulnerableActive, isFallen, stepWeeks, type EventType, type SimEvent, type SimState } from "../sim";
import type { MapData, VictoryCity } from "../sim/mapTypes";
import { el } from "./dom";
import { fleetBadges } from "./fleets";
import { deathToll, formatPeople } from "./news";
import { cityMarkers } from "./cityMarkers";
import { mapOptions, mapOptionToggles } from "./mapOptions";

export interface ResultOptions {
  map: MapData;
  /** The finished simulation. */
  sim: SimState;
  /** Re-run the same scenario with a different seed. */
  onRerun: () => void;
  onSetup: () => void;
}

const TYPE_LABEL: Record<EventType, string> = {
  war: "参戦", capitalFall: "首都陥落", capitalRecapture: "首都奪還", capitulation: "降伏", revival: "復活", transfer: "合流", cityFall: "都市陥落",
  cityRecapture: "奪還", fleetBattle: "艦隊決戦", victory: "終結", stalemate: "終結",
};
/** Countries whose events count as "major" in the timeline (preset industry at least this). */
const MAJOR_INDUSTRY = 3;

/** Result screen: winner (or stalemate), end date, final map and a timeline of major events. */
export class ResultScreen {
  readonly root: HTMLElement;
  private renderer: MapRenderer;

  constructor(container: HTMLElement, opts: ResultOptions) {
    const { sim, map } = opts;
    const r = sim.result!;
    const title = r.winner === "allies" ? "連合国の勝利" : r.winner === "axis" ? "枢軸国の勝利" : "膠着";
    const cond = r.condition === "axisA" ? "条件A: ロンドン・モスクワ・ホノルルの陥落"
      : r.condition === "axisB" ? `条件B: モスクワ陥落とパリ・${[...sim.config.axisBCapitals.map((t) => capitalName(t))].join("・")}の保持が${sim.config.axisBWeeks}週継続`
      : r.condition === "allies" ? `${alliedVictoryCountries(sim).map((c) => sim.names[c]).join("・")}の降伏`
      : "打ち切り日までにどちらの勝利条件も満たされなかった";
    const weeks = (r.endTick + 1) * stepWeeks(sim.config);
    const years = Math.floor(weeks / 52), restWeeks = weeks % 52;

    const mapBox = el("div", { class: "obs-map" });
    const milBox = el("div", { class: "chart" }), navyBox = el("div", { class: "chart" }), indBox = el("div", { class: "chart" });
    const timeline = el("ol", { class: "timeline" });
    const majorOnly = el("input", { type: "checkbox", checked: "" }) as HTMLInputElement;
    const rerun = el("button", { class: "btn primary", type: "button" }, "同じ条件・別のシードで再実行") as HTMLButtonElement;
    const setup = el("button", { class: "btn", type: "button" }, "セットアップに戻る") as HTMLButtonElement;
    rerun.onclick = opts.onRerun;
    setup.onclick = opts.onSetup;

    this.root = el("div", { class: "result" },
      el("header", { class: "topbar" },
        el("div", { class: "title" }, "結果", el("span", { class: "seed" }, `${sim.scenario.name}・シード ${sim.seed}`)),
        el("div", { class: "controls" }, rerun, setup),
      ),
      el("main", { class: "obs-body" },
        el("div", { class: "obs-map-wrap" }, mapBox,
          el("div", { class: "map-legend" },
            el("span", {}, el("i", { class: "band axis" }), "枢軸国"),
            el("span", {}, el("i", { class: "band allies" }), "連合国"),
            el("span", {}, el("i", { class: "dot" }), "勝利条件の都市(黄 = 陥落)"),
            ...mapOptionToggles(["fleets", "cityNames"], () => drawMap()),
          ),
        ),
        el("aside", { class: "obs-side" },
          el("section", { class: `panel result-head ${r.winner}` },
            el("div", { class: "winner" }, title),
            el("div", { class: "cond" }, cond),
            el("div", { class: "end" }, `終結日 ${formatDateJa(r.endDate)}(開戦から ${years}年${restWeeks}週)`),
            el("div", { class: "cities" }, ...(Object.keys(CITY_NAMES) as VictoryCity[]).map((c) =>
              el("span", { class: `city ${isFallen(sim, c) ? "fallen" : ""}` }, CITY_NAMES[c], el("b", {}, isFallen(sim, c) ? "陥落" : "保持")))),
            lossTable(sim),
          ),
          el("section", { class: "panel charts" }, milBox, navyBox, indBox),
          el("section", { class: "panel log-panel" },
            el("div", { class: "timeline-head" }, el("h2", {}, "年表"),
              el("label", { class: "hint" }, majorOnly, "主要国・勝利条件の都市・重要都市のみ")),
            timeline),
        ),
      ),
    );
    container.appendChild(this.root);

    const colors = sim.tags.map((t) => sim.scenario.countries[t]?.color ?? "#999");
    const fIdx = Int8Array.from(sim.faction, (f) => (f === "axis" ? 0 : f === "allies" ? 1 : -1));
    this.renderer = new MapRenderer(map, mapBox);
    const drawMap = () => this.renderer.draw({
      fill: (i) => colors[sim.owner[i]],
      bands: { group: (i) => fIdx[sim.owner[i]], colors: [FACTION_COLORS.axis, FACTION_COLORS.allies] },
      hatched: (i) => invulnerableActive(sim, i),
      badges: mapOptions().fleets ? fleetBadges(sim, map) : undefined,
      markers: cityMarkers(map, sim.scenario, sim),
      showLabels: mapOptions().cityNames,
    });
    drawMap();

    const stepMs = sim.config.stepDays * DAY_MS;
    const xMax = Math.ceil((sim.endMs - sim.startMs) / stepMs);
    const xTicks: [number, string][] = [];
    for (let y = 1940; y <= 1950; y += 2) xTicks.push([Math.round((Date.UTC(y, 0, 1) - sim.startMs) / stepMs), String(y)]);
    const h = sim.history;
    new LineChart(milBox, { title: "陸軍力", xMax, xTicks }).draw([
      { label: FACTION_NAMES.axis, color: FACTION_COLORS.axis, values: h.map((x) => x.military.axis) },
      { label: FACTION_NAMES.allies, color: FACTION_COLORS.allies, values: h.map((x) => x.military.allies) },
    ]);
    new LineChart(navyBox, { title: "海軍力", xMax, xTicks }).draw([
      { label: FACTION_NAMES.axis, color: FACTION_COLORS.axis, values: h.map((x) => x.navy.axis) },
      { label: FACTION_NAMES.allies, color: FACTION_COLORS.allies, values: h.map((x) => x.navy.allies) },
    ]);
    new LineChart(indBox, { title: "陸軍生産力", xMax, xTicks }).draw([
      { label: FACTION_NAMES.axis, color: FACTION_COLORS.axis, values: h.map((x) => x.industry.axis) },
      { label: FACTION_NAMES.allies, color: FACTION_COLORS.allies, values: h.map((x) => x.industry.allies) },
    ]);

    // Fleet battles are frequent; the "major" view keeps only the others.
    const isMajor = (e: SimEvent) =>
      e.type !== "fleetBattle" && (e.type === "victory" || e.type === "stalemate" || e.city !== undefined || e.importantCity !== undefined ||
      e.countries.some((t) => (sim.scenario.countries[t]?.industry ?? 0) >= MAJOR_INDUSTRY));
    const renderTimeline = () => {
      const evs = sim.events.filter((e) => !majorOnly.checked || isMajor(e));
      const items: HTMLElement[] = [];
      let year = "";
      for (const e of evs) {
        if (e.date.slice(0, 4) !== year) {
          year = e.date.slice(0, 4);
          items.push(el("li", { class: "tl-year" }, `${year}年`));
        }
        items.push(el("li", { class: `ev ev-${e.type}` },
          el("span", { class: "ev-date" }, formatDateJa(e.date).slice(5)),
          el("span", { class: "ev-tag" }, TYPE_LABEL[e.type]),
          el("span", { class: "ev-text" }, e.text)));
      }
      timeline.replaceChildren(...items);
    };
    majorOnly.onchange = renderTimeline;
    renderTimeline();
  }

  destroy() {
    this.root.remove();
  }
}

/** Deaths per faction and arm, converted to people like the closing headline (config.peoplePerArmyLoss / NavyLoss). */
function lossTable(sim: SimState): HTMLElement {
  const { peoplePerArmyLoss, peoplePerNavyLoss } = sim.config;
  const row = (f: "axis" | "allies") =>
    el("tr", {}, el("th", { style: `color:${FACTION_COLORS[f]}` }, FACTION_NAMES[f]),
      el("td", {}, formatPeople(sim.losses[f].army * peoplePerArmyLoss)),
      el("td", {}, formatPeople(sim.losses[f].navy * peoplePerNavyLoss)));
  return el("div", { class: "losses" },
    el("div", { class: "toll" }, `犠牲者(軍人) ${formatPeople(deathToll(sim))}`),
    el("table", {},
      el("tr", {}, el("th", {}, ""), el("th", {}, "陸軍の死者"), el("th", {}, "海軍の死者")),
      row("axis"), row("allies")));
}
