import { FACTION_COLORS, FACTION_NAMES, formatDateJa } from "../data";
import { LineChart } from "../render/charts";
import { MapRenderer } from "../render/mapRenderer";
import {
  CITY_NAMES, DAY_MS, capitalHeldByAxis, capitalName, createSimulation, formatDate, invulnerableActive, isFallen, step, stepWeeks,
  tickTime, victoryTargets,
  type EventType, type Scenario, type SimConfig, type SimResult, type SimState,
} from "../sim";
import { fleetBadges } from "./fleets";
import type { MapData, VictoryCity } from "../sim/mapTypes";
import { el } from "./dom";
import { TERRAIN_NAMES } from "./terrain";
import { endHeadline, headline } from "./news";
import { NewsQueue } from "./newsQueue";
import { renderFronts } from "./fronts";
import { cityMarkers } from "./cityMarkers";
import { mapOptions, mapOptionToggles } from "./mapOptions";
import { MajorNewsQueue, majorHeadline } from "./majorNews";

const LOG_TYPES: EventType[] = ["war", "capitalFall", "capitalRecapture", "capitulation", "revival", "transfer", "cityFall", "cityRecapture", "fleetBattle", "victory", "stalemate"];
const LOG_LABEL: Record<EventType, string> = {
  war: "参戦", capitalFall: "首都陥落", capitalRecapture: "首都奪還", capitulation: "降伏", revival: "復活", transfer: "合流", cityFall: "都市陥落",
  cityRecapture: "奪還", fleetBattle: "艦隊決戦", victory: "終結", stalemate: "終結",
};
// Steps are cheap (~0.1 ms); only the map redraw is per frame. These caps keep playback real-time even
// at low frame rates while preventing a huge jump after the tab was asleep.
const MAX_STEPS_PER_FRAME = 80;
const MAX_FRAME_SECONDS = 1;

export interface ObserveOptions {
  map: MapData;
  scenario: Scenario;
  seed: number;
  config?: Partial<SimConfig>;
  /** Called once when the war ends (victory or stalemate). */
  onFinish?: (result: SimResult, sim: SimState) => void;
  /** Shows a "セットアップに戻る" button when given. */
  onBack?: () => void;
  /** Shows a "結果を見る" button in the end banner when given. */
  onResult?: (sim: SimState) => void;
}

/** Observation screen: plays the simulation back automatically; the player only watches. */
/** Real-time interval between rebuilds of the fronts panel. */
const FRONTS_REFRESH_MS = 250;

export class ObserveScreen {
  readonly root: HTMLElement;
  readonly sim: SimState;
  private renderer: MapRenderer;
  private charts: { military: LineChart; navy: LineChart; industry: LineChart };
  private dateEl: HTMLElement;
  private pauseBtn: HTMLButtonElement;
  private speedInput: HTMLInputElement;
  private speedLabel: HTMLElement;
  private victoryEl: HTMLElement;
  private frontsEl: HTMLElement;
  private frontsTick = -1;
  private frontsAt = -Infinity;
  private logEl: HTMLOListElement;
  private tooltip: HTMLElement;
  private banner: HTMLElement;
  /** News advances in real time; same-frame events are queued and remain in the history. */
  private newsEl: HTMLElement;
  private newsText: HTMLElement;
  private newsDate: HTMLElement;
  private newsQueue = new NewsQueue();
  private newsCount: HTMLElement;
  private newsSummary: HTMLElement;
  private newsHistory: HTMLOListElement;
  private newsNext: HTMLButtonElement;
  private majorQueue = new MajorNewsQueue();
  private majorPopup: HTMLElement;
  private majorText: HTMLElement;
  private paused = false;
  private speed = 1;
  private acc = 0;
  private lastFrame = 0;
  private raf = 0;
  private loggedEvents = 0;
  private hover: number | null = null;
  private colors: string[];
  private factionIndex: Int8Array;
  private finished = false;

  constructor(container: HTMLElement, private opts: ObserveOptions) {
    const { map, scenario, seed } = opts;
    this.sim = createSimulation(map, scenario, { seed, config: opts.config });
    const sim = this.sim;
    this.colors = sim.tags.map((t) => scenario.countries[t]?.color ?? "#999");
    this.factionIndex = Int8Array.from(sim.faction, (f) => (f === "axis" ? 0 : f === "allies" ? 1 : -1));

    this.dateEl = el("div", { class: "obs-date" });
    this.pauseBtn = el("button", { class: "btn", type: "button" }, "一時停止") as HTMLButtonElement;
    this.speedInput = el("input", {
      type: "range", min: String(sim.config.speedMin), max: String(sim.config.speedMax), step: "0.5", value: "1",
      "aria-label": "再生速度",
    }) as HTMLInputElement;
    this.speedLabel = el("span", { class: "speed-label" }, "1.0x");
    const backBtn = el("button", { class: "btn", type: "button" }, "セットアップに戻る") as HTMLButtonElement;
    backBtn.onclick = () => opts.onBack?.();
    backBtn.hidden = !opts.onBack;
    const mapBox = el("div", { class: "obs-map" });
    this.tooltip = el("div", { class: "map-tooltip", hidden: "" });
    this.banner = el("div", { class: "obs-banner", hidden: "" });
    this.majorText = el("strong", { class: "major-news-text" });
    this.majorPopup = el("div", {
      class: "major-news-popup", hidden: "", role: "status", "aria-live": "polite", "aria-atomic": "true",
    }, this.majorText);
    this.newsText = el("span", { class: "news-text" }, "ニュースはまだありません");
    this.newsDate = el("span", { class: "news-date" });
    this.newsCount = el("span", { class: "news-count" });
    this.newsNext = el("button", { class: "btn news-next", type: "button" }, "次へ") as HTMLButtonElement;
    this.newsSummary = el("summary", {}, "履歴 0件");
    this.newsHistory = el("ol", { class: "news-history-list" }) as HTMLOListElement;
    this.newsEl = el("div", { class: "news-bar" },
      el("div", { class: "news-current", role: "status", "aria-live": "polite", "aria-atomic": "true" },
        el("span", { class: "news-label" }, "ニュース"), this.newsDate, this.newsText),
      el("div", { class: "news-controls" }, this.newsCount, this.newsNext,
        el("details", { class: "news-history" }, this.newsSummary, this.newsHistory)));
    this.newsNext.onclick = () => { this.newsQueue.next(performance.now()); this.renderNews(); };
    if (scenario.openingNews) this.enqueueNews(sim.config.startDate, scenario.openingNews);
    this.victoryEl = el("div", { class: "victory" });
    this.frontsEl = el("div", { class: "fronts" });
    this.logEl = el("ol", { class: "event-log" }) as HTMLOListElement;
    const milBox = el("div", { class: "chart" }), navyBox = el("div", { class: "chart" }), indBox = el("div", { class: "chart" });

    this.root = el("div", { class: "observe" },
      el("header", { class: "topbar" },
        el("div", { class: "title" }, scenario.name, el("span", { class: "seed" }, `シード ${seed}`)),
        this.dateEl,
        el("div", { class: "controls" }, this.pauseBtn, el("label", { class: "speed" }, "速度", this.speedInput, this.speedLabel), backBtn),
      ),
      el("main", { class: "obs-body" },
        el("div", { class: "obs-map-wrap" }, this.newsEl, mapBox, this.tooltip,
          el("div", { class: "obs-notifications" }, this.majorPopup, this.banner),
          el("div", { class: "map-legend" },
            el("span", {}, el("i", { class: "band axis" }), "枢軸国"),
            el("span", {}, el("i", { class: "band allies" }), "連合国"),
            el("span", {}, el("i", { class: "hatch" }), "占領不可"),
            el("span", {}, el("i", { class: "dot" }), "勝利条件の都市"),
            el("span", {}, el("i", { class: "important-dot" }), "重要都市"),
            el("span", {}, el("i", { class: "fleet" }), "艦隊(戦域ごとの海軍力)"),
            ...mapOptionToggles(["fleets", "cityNames"], () => this.drawMap()),
          ),
        ),
        el("aside", { class: "obs-side" },
          el("section", { class: "panel" }, el("h2", {}, "勝利条件の進捗"), this.victoryEl),
          el("section", { class: "panel fronts-panel" }, el("h2", {}, "戦線の陸軍"), this.frontsEl),
          el("section", { class: "panel charts" }, milBox, navyBox, indBox),
          el("section", { class: "panel log-panel" }, el("h2", {}, "イベントログ"), this.logEl),
        ),
      ),
    );
    container.appendChild(this.root);

    this.renderer = new MapRenderer(map, mapBox);
    this.renderer.onHoverState = (id) => this.onHover(id);
    mapBox.addEventListener("pointerleave", () => this.onHover(null));
    mapBox.addEventListener("pointermove", (e) => this.placeTooltip(e));

    const years = Math.ceil((sim.endMs - sim.startMs) / (365.25 * 86_400_000));
    const stepMs = sim.config.stepDays * DAY_MS;
    const xMax = Math.ceil((sim.endMs - sim.startMs) / stepMs);
    const xTicks: [number, string][] = [];
    for (let y = 1940; y <= 1939 + years; y += 2) {
      xTicks.push([Math.round((Date.UTC(y, 0, 1) - sim.startMs) / stepMs), String(y)]);
    }
    this.charts = {
      military: new LineChart(milBox, { title: "陸軍力", xMax, xTicks }),
      navy: new LineChart(navyBox, { title: "海軍力", xMax, xTicks }),
      industry: new LineChart(indBox, { title: "陸軍生産力", xMax, xTicks }),
    };

    this.pauseBtn.onclick = () => this.setPaused(!this.paused);
    this.speedInput.oninput = () => {
      this.speed = Number(this.speedInput.value);
      this.speedLabel.textContent = `${this.speed.toFixed(1)}x`;
    };
    this.onKey = this.onKey.bind(this);
    window.addEventListener("keydown", this.onKey);

    this.updatePanels();
    this.drawMap();
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("keydown", this.onKey);
    this.root.remove();
  }

  private onKey(e: KeyboardEvent) {
    if (e.code === "Space" && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      this.setPaused(!this.paused);
    }
  }

  setPaused(p: boolean) {
    if (this.finished) return;
    this.paused = p;
    this.pauseBtn.textContent = p ? "再開" : "一時停止";
    this.pauseBtn.classList.toggle("active", p);
  }

  /** Seconds of real time per half-week update; calendar playback speed stays unchanged. */
  private tickSeconds() {
    return this.sim.config.secondsPerYear / 52 * stepWeeks(this.sim.config) / this.speed;
  }

  private frame(now: number) {
    const dt = Math.min(MAX_FRAME_SECONDS, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (!this.paused && !this.sim.result) {
      this.acc += dt;
      const ts = this.tickSeconds();
      let steps = 0;
      while (this.acc >= ts && !this.sim.result && steps < MAX_STEPS_PER_FRAME) {
        step(this.sim);
        this.acc -= ts;
        steps++;
      }
      if (steps) this.afterSteps();
    }
    if (this.newsQueue.update(now)) this.renderNews();
    if (this.majorQueue.update(now)) this.renderMajorNews();
    // Keep draining the final week's headlines and closing news after simulation playback has ended.
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private afterSteps() {
    // The map is redrawn after half-week updates; the renderer only rebuilds paths for
    // states whose owner changed.
    this.drawMap();
    this.updatePanels();
    if (this.sim.result && !this.finished) {
      this.finished = true;
      this.drawMap();
      this.showBanner(this.sim.result);
      this.enqueueNews(this.sim.result.endDate, endHeadline(this.sim));
      this.pauseBtn.disabled = true;
      this.opts.onFinish?.(this.sim.result, this.sim);
    }
  }

  private currentDate(): string {
    // The tick counter has already advanced past the last processed week unless the war just ended.
    const t = this.sim.result ? this.sim.result.endTick : Math.max(0, this.sim.tick - 1);
    return formatDate(tickTime(this.sim.startMs, t, this.sim.config.stepDays));
  }

  private drawMap() {
    const sim = this.sim;
    const markers = cityMarkers(this.opts.map, this.opts.scenario, sim);
    this.renderer.draw({
      fill: (i) => this.colors[sim.owner[i]],
      bands: { group: (i) => this.factionIndex[sim.owner[i]], colors: [FACTION_COLORS.axis, FACTION_COLORS.allies] },
      hatched: (i) => invulnerableActive(sim, i),
      highlight: this.hover,
      markers,
      showLabels: mapOptions().cityNames,
      badges: mapOptions().fleets ? fleetBadges(sim, this.opts.map) : undefined,
    });
  }

  private updatePanels() {
    const sim = this.sim;
    this.dateEl.textContent = formatDateJa(this.currentDate());
    this.renderVictory();
    // Fronts: rebuilt at most every FRONTS_REFRESH_MS of real time (the list is read, not animated), and at the end.
    const now = performance.now();
    if (this.sim.tick !== this.frontsTick && (now - this.frontsAt >= FRONTS_REFRESH_MS || this.sim.result)) {
      this.frontsTick = this.sim.tick;
      this.frontsAt = now;
      this.frontsEl.replaceChildren(...renderFronts(this.sim));
    }
    const h = sim.history;
    this.charts.military.draw([
      { label: FACTION_NAMES.axis, color: FACTION_COLORS.axis, values: h.map((x) => x.military.axis) },
      { label: FACTION_NAMES.allies, color: FACTION_COLORS.allies, values: h.map((x) => x.military.allies) },
    ]);
    this.charts.navy.draw([
      { label: FACTION_NAMES.axis, color: FACTION_COLORS.axis, values: h.map((x) => x.navy.axis) },
      { label: FACTION_NAMES.allies, color: FACTION_COLORS.allies, values: h.map((x) => x.navy.allies) },
    ]);
    this.charts.industry.draw([
      { label: FACTION_NAMES.axis, color: FACTION_COLORS.axis, values: h.map((x) => x.industry.axis) },
      { label: FACTION_NAMES.allies, color: FACTION_COLORS.allies, values: h.map((x) => x.industry.allies) },
    ]);
    for (; this.loggedEvents < sim.events.length; this.loggedEvents++) {
      const e = sim.events[this.loggedEvents];
      // The opening week's declarations are already covered by the scenario's opening headline.
      const news = e.tick > 0 ? headline(e, this.opts.scenario) : null;
      if (news) this.enqueueNews(e.date, news);
      const major = majorHeadline(e, this.opts.scenario);
      if (major) {
        this.majorQueue.add({ date: e.date, text: major }, performance.now());
        this.renderMajorNews();
      }
      if (!LOG_TYPES.includes(e.type)) continue;
      const li = el("li", { class: `ev ev-${e.type}` },
        el("span", { class: "ev-date" }, formatDateJa(e.date)),
        el("span", { class: "ev-tag" }, LOG_LABEL[e.type]),
        el("span", { class: "ev-text" }, e.text),
      );
      this.logEl.prepend(li);
    }
  }

  private enqueueNews(date: string, text: string) {
    this.newsQueue.add({ date, text }, performance.now());
    this.newsHistory.prepend(el("li", {},
      el("span", { class: "news-history-date" }, formatDateJa(date)), el("span", {}, text)));
    this.newsSummary.textContent = `履歴 ${this.newsQueue.items.length}件`;
    this.renderNews();
  }

  private renderNews() {
    const current = this.newsQueue.current;
    if (current) {
      this.newsDate.textContent = formatDateJa(current.date);
      this.newsText.textContent = current.text;
      this.newsText.title = current.text;
    }
    this.newsCount.textContent = this.newsQueue.pending ? `待機 ${this.newsQueue.pending}件` : "";
    this.newsNext.disabled = !this.newsQueue.pending;
  }

  private renderMajorNews() {
    const current = this.majorQueue.current;
    this.majorPopup.hidden = !current;
    this.majorText.textContent = current?.text ?? "";
  }

  private renderVictory() {
    const sim = this.sim;
    const cell = (c: VictoryCity) => {
      const fallen = isFallen(sim, c);
      return el("span", { class: `city ${fallen ? "fallen" : ""}`, title: fallen ? "陥落" : "保持" },
        CITY_NAMES[c], el("b", {}, fallen ? "陥落" : "保持"));
    };
    const parisAxis = sim.faction[sim.owner[sim.cities.Paris]] === "axis";
    const weeks = sim.axisBWeeks, need = sim.config.axisBWeeks;
    // Targets follow the factions set up per country (victoryTargets); a condition without cities is shown as such.
    const t = victoryTargets(sim);
    const cities = (list: VictoryCity[]) =>
      el("div", { class: "vc-cities" }, ...(list.length ? list.map(cell) : [el("span", { class: "hint" }, "対象の都市なし(成立しない)")]));
    this.victoryEl.replaceChildren(
      el("div", { class: "vc" }, el("div", { class: "vc-name axis" }, "枢軸 A"), cities(t.axisA)),
      el("div", { class: "vc" }, el("div", { class: "vc-name axis" }, "枢軸 B"),
        ...(t.axisB ? [
          el("div", { class: "vc-cities" }, cell("Moscow"),
            el("span", { class: `city ${parisAxis ? "fallen" : ""}` }, "パリ", el("b", {}, parisAxis ? "枢軸が保持" : "未保持")),
            // Capitals the Axis must also hold (config.axisBCapitals: Chongqing).
            ...t.axisBCapitals.map((c) => {
              const held = capitalHeldByAxis(sim, c);
              return el("span", { class: `city ${held ? "fallen" : ""}` }, capitalName(sim.tags[c]), el("b", {}, held ? "枢軸が保持" : "未保持"));
            })),
          el("div", { class: "vc-progress" },
            el("div", { class: "bar" }, el("i", { style: `width:${Math.min(100, (100 * weeks) / need)}%` })),
            el("span", {}, `${weeks} / ${need} 週`))]
          : [cities([])])),
      el("div", { class: "vc" }, el("div", { class: "vc-name allies" }, "連合国"), cities(t.allies)),
    );
  }

  private showBanner(r: SimResult) {
    const title = r.winner === "allies" ? "連合国の勝利" : r.winner === "axis" ? "枢軸国の勝利" : "膠着";
    const cond = r.condition === "axisA" ? "(条件A)" : r.condition === "axisB" ? "(条件B)" : "";
    const toResult = el("button", { class: "btn primary", type: "button" }, "結果を見る") as HTMLButtonElement;
    toResult.onclick = () => this.opts.onResult?.(this.sim);
    this.banner.replaceChildren(el("strong", {}, title + cond), el("span", {}, `${formatDateJa(r.endDate)} 終結`),
      ...(this.opts.onResult ? [toResult] : []));
    this.banner.className = `obs-banner ${r.winner}`;
    this.banner.hidden = false;
  }

  private onHover(id: number | null) {
    if (id === this.hover) return;
    this.hover = id;
    this.drawMap();
    if (id === null) {
      this.tooltip.hidden = true;
      return;
    }
    const sim = this.sim;
    const o = sim.owner[id], orig = sim.origOwner[id];
    const lines = [`${sim.names[o]}${o !== orig ? `(${sim.names[orig]}から占領)` : ""}`];
    for (const city of sim.importantCities) if (city.state === id) lines.push(city.name);
    const capOf = sim.capital.indexOf(id);
    if (capOf >= 0) lines.push(`${sim.names[capOf]}の首都`);
    if (invulnerableActive(sim, id)) lines.push("占領不可");
    lines.push(`攻略難易度: ${TERRAIN_NAMES[sim.terrain[id]]}`);
    this.tooltip.replaceChildren(...lines.map((l) => el("div", {}, l)));
    this.tooltip.hidden = false;
  }

  private placeTooltip(e: PointerEvent) {
    const box = this.root.querySelector(".obs-map-wrap")!.getBoundingClientRect();
    this.tooltip.style.left = `${e.clientX - box.left + 14}px`;
    this.tooltip.style.top = `${e.clientY - box.top + 14}px`;
  }
}
