import { FACTION_COLORS, FACTION_NAMES } from "../data";
import { MapRenderer } from "../render/mapRenderer";
import {
  INDUSTRY_MAX, applyFactions, applyScenarioFile, setFaction, capitalName, capitalOf, clampIndustry, clampShipbuilding, clampStability, cloneScenario,
  entryDates, toScenarioFile, type Faction, type Scenario,
} from "../sim";
import type { MapData } from "../sim/mapTypes";
import { cityMarkers } from "./cityMarkers";
import { mapOptions, mapOptionToggles } from "./mapOptions";
import { el } from "./dom";
import { TERRAIN_NAMES } from "./terrain";
import { icon } from "./icons";
import { creditsPanel } from "./credits";

export interface SetupOptions {
  map: MapData;
  /** The historical preset (also the source of factions, war dates and invulnerable states). */
  preset: Scenario;
  /** State to resume (e.g. the edits made before going to the observation screen). */
  initial?: SetupState;
  onStart: (scenario: Scenario) => void;
}

export interface SetupState {
  scenario: Scenario;
  /** What "リセット" returns to: the last preset or file loaded. */
  baseline: Scenario;
}

type Filter = "all" | Faction;
const FILTERS: [Filter, string][] = [["all", "すべて"], ["axis", "枢軸国"], ["allies", "連合国"], ["neutral", "中立国"]];
const SELECT_COLOR = "#ffffff";
const fmtInd = (v: number) => String(Math.round(v * 100) / 100);
const fmtStab = (v: number) => v.toFixed(2);

/**
 * Setup screen. Editable per country: army production, naval production and political stability.
 * Capitals are fixed to the map's original locations; clicking a state only selects its country.
 * Industrial capacity is their displayed sum, with historical multipliers and expandable components.
 * Factions, war dates and invulnerable states are shown only.
 */
export class SetupScreen {
  readonly root: HTMLElement;
  private scenario: Scenario;
  /** What "リセット" returns to: the last preset or file loaded. */
  private baseline: Scenario;
  private selected: string;
  private filter: Filter = "all";
  private query = "";
  private productionExpanded = false;
  private renderer: MapRenderer;
  private colors: string[];
  private tagIndex: Map<string, number>;
  private entry: Record<string, string | null>;
  private seedInput: HTMLInputElement;
  private detailEl: HTMLElement;
  private summaryEl: HTMLElement;
  private listEl: HTMLElement;
  private noticeEl: HTMLElement;
  private tooltip: HTMLElement;
  private fileInput: HTMLInputElement;
  private hover: number | null = null;

  constructor(container: HTMLElement, private opts: SetupOptions) {
    const { map, preset } = opts;
    this.scenario = cloneScenario(opts.initial?.scenario ?? preset);
    this.baseline = cloneScenario(opts.initial?.baseline ?? preset);
    this.entry = entryDates(applyFactions(preset, this.scenario));
    const tags = Object.keys(map.countries).sort();
    this.tagIndex = new Map(tags.map((t, i) => [t, i]));
    this.colors = tags.map((t) => preset.countries[t]?.color ?? "#999");
    // Start with Germany selected: the most likely first edit.
    this.selected = this.scenario.countries.GER ? "GER" : tags[0];

    this.seedInput = el("input", { type: "number", step: "1", class: "seed-input", "aria-label": "乱数シード" }) as HTMLInputElement;
    this.fileInput = el("input", { type: "file", accept: "application/json,.json", hidden: "" }) as HTMLInputElement;
    const btn = (label: string, onClick: () => void, cls = "btn") => {
      const b = el("button", { class: cls, type: "button" }, label) as HTMLButtonElement;
      b.onclick = onClick;
      return b;
    };
    this.noticeEl = el("div", { class: "notice", hidden: "" });
    this.detailEl = el("div", { class: "detail" });
    this.summaryEl = el("div", { class: "summary" });
    this.listEl = el("div", { class: "country-list" });
    this.tooltip = el("div", { class: "map-tooltip", hidden: "" });
    const search = el("input", { type: "search", placeholder: "国名で絞り込み", class: "search" }) as HTMLInputElement;
    search.oninput = () => { this.query = search.value.trim(); this.renderList(); };
    const filterBar = el("div", { class: "filters", role: "tablist" });
    for (const [f, label] of FILTERS) {
      const b = btn(label, () => {
        this.filter = f;
        filterBar.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
        this.renderList();
      }, `chip ${f === "all" ? "active" : ""}`);
      filterBar.append(b);
    }
    const mapBox = el("div", { class: "obs-map" });

    this.root = el("div", { class: "setup" },
      el("header", { class: "topbar" },
        el("div", { class: "title" }, "セットアップ", el("span", { class: "seed" }, "1939年9月1日開始・観察専用")),
        el("label", { class: "seed-field" }, "乱数シード", this.seedInput,
          btn("ランダム", () => this.setSeed(Math.floor(Math.random() * 1e9)), "btn small")),
        el("div", { class: "controls" },
          btn("史実プリセット", () => this.loadPreset()),
          btn("リセット", () => this.reset()),
          btn("JSON保存", () => this.save()),
          btn("JSON読込", () => this.fileInput.click()),
          this.fileInput,
          btn("開始", () => this.start(), "btn primary"),
        ),
      ),
      this.noticeEl,
      el("main", { class: "obs-body" },
        el("div", { class: "obs-map-wrap" }, mapBox, this.tooltip,
          el("div", { class: "map-hint" }, "地図をクリックして国を選択できます。"),
          el("div", { class: "map-legend" },
            el("span", {}, el("i", { class: "band select" }), "選択中の国"),
            el("span", {}, el("i", { class: "band axis" }), "枢軸国"),
            el("span", {}, el("i", { class: "band allies" }), "連合国"),
            el("span", {}, el("i", { class: "hatch" }), "占領不可"),
            el("span", {}, el("i", { class: "important-dot" }), "重要都市"),
            ...mapOptionToggles(["cityNames"], () => this.drawMap()),
          ),
        ),
        el("aside", { class: "obs-side setup-side" },
          el("section", { class: "panel" }, this.detailEl),
          el("section", { class: "panel" }, el("h2", {}, "陣営の合計(開戦時)"), this.summaryEl),
          el("section", { class: "panel list-panel" }, el("h2", {}, "国の一覧"), el("div", { class: "list-tools" }, filterBar, search), this.listEl),
          creditsPanel(),
        ),
      ),
    );
    container.appendChild(this.root);

    this.seedInput.onchange = () => {
      const v = Number(this.seedInput.value);
      if (Number.isInteger(v)) this.scenario.seed = v;
      this.seedInput.value = String(this.scenario.seed);
    };
    this.fileInput.onchange = () => this.load();

    this.renderer = new MapRenderer(map, mapBox);
    this.renderer.onClickState = (id) => this.onMapClick(id);
    this.renderer.onHoverState = (id) => this.onHover(id);
    mapBox.addEventListener("pointerleave", () => this.onHover(null));
    mapBox.addEventListener("pointermove", (e) => {
      const box = mapBox.getBoundingClientRect();
      this.tooltip.style.left = `${e.clientX - box.left + 14}px`;
      this.tooltip.style.top = `${e.clientY - box.top + 14}px`;
    });
    this.renderAll();
  }

  destroy() {
    this.root.remove();
  }

  /** Current edits and baseline (copies), to resume the screen later. */
  getState(): SetupState {
    return { scenario: cloneScenario(this.scenario), baseline: cloneScenario(this.baseline) };
  }

  // ---- actions ----

  private notify(lines: string[], kind: "info" | "warn" | "error" = "info") {
    if (!lines.length) {
      this.noticeEl.hidden = true;
      return;
    }
    this.noticeEl.className = `notice ${kind}`;
    this.noticeEl.replaceChildren(...lines.slice(0, 6).map((l) => el("div", {}, l)),
      ...(lines.length > 6 ? [el("div", {}, `ほか ${lines.length - 6} 件`)] : []));
    this.noticeEl.hidden = false;
  }

  private isDirty(): boolean {
    return JSON.stringify(this.scenario) !== JSON.stringify(this.baseline);
  }

  private loadPreset() {
    if (this.isDirty() && !confirm("編集内容を破棄して史実プリセットを読み込みますか?")) return;
    this.scenario = cloneScenario(this.opts.preset);
    this.baseline = cloneScenario(this.opts.preset);
    this.notify(["史実プリセットを読み込みました"]);
    this.renderAll();
  }

  private reset() {
    if (!this.isDirty()) return;
    if (!confirm("最後に読み込んだ状態に戻しますか?")) return;
    this.scenario = cloneScenario(this.baseline);
    this.notify(["最後に読み込んだ状態に戻しました"]);
    this.renderAll();
  }

  private save() {
    const file = toScenarioFile(this.scenario, this.opts.map);
    const blob = new Blob([JSON.stringify(file, null, 1)], { type: "application/json" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `ww2-scenario-seed${this.scenario.seed}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    this.baseline = cloneScenario(this.scenario);
    this.notify(["シナリオを保存しました(陸軍生産力・海軍生産力・政治安定性・シード)"]);
  }

  private async load() {
    const f = this.fileInput.files?.[0];
    this.fileInput.value = "";
    if (!f) return;
    try {
      const { scenario, warnings } = applyScenarioFile(await f.text(), this.opts.preset, this.opts.map);
      this.scenario = scenario;
      this.baseline = cloneScenario(scenario);
      this.notify([`${f.name} を読み込みました`, ...warnings], warnings.length ? "warn" : "info");
      this.renderAll();
    } catch (e) {
      this.notify([`読み込めませんでした: ${e instanceof Error ? e.message : String(e)}`], "error");
    }
  }

  private start() {
    // War declarations follow the factions chosen here (applyFactions); unchanged factions keep the history.
    this.opts.onStart(applyFactions(this.opts.preset, this.scenario));
  }

  private setSeed(v: number) {
    this.scenario.seed = v;
    this.seedInput.value = String(v);
  }

  private select(tag: string) {
    this.selected = tag;
    this.renderDetail();
    this.renderList();
    this.drawMap();
    this.listEl.querySelector(`[data-tag="${tag}"]`)?.scrollIntoView({ block: "nearest" });
  }

  private onMapClick(id: number) {
    const owner = this.opts.map.states[id].owner;
    if (owner !== this.selected) this.select(owner);
  }

  private onHover(id: number | null) {
    if (id === this.hover) return;
    this.hover = id;
    this.drawMap();
    if (id === null) {
      this.tooltip.hidden = true;
      return;
    }
    const tag = this.opts.map.states[id].owner;
    const c = this.scenario.countries[tag];
    const lines = [c?.name ?? tag];
    for (const city of this.opts.map.importantCities ?? []) if (city.state === id) lines.push(city.name);
    if (capitalOf(this.opts.map, tag) === id) lines.push(`首都: ${capitalName(tag)}`);
    if (this.scenario.stateOverrides?.[String(id)]?.invulnerable) lines.push("占領不可");
    lines.push(`攻略難易度: ${TERRAIN_NAMES[this.opts.map.terrain?.[id] ?? 1]}`);
    lines.push(tag === this.selected ? "選択中の国" : "クリックでこの国を選択");
    this.tooltip.replaceChildren(...lines.map((l) => el("div", {}, l)));
    this.tooltip.hidden = false;
  }

  private setIndustry(tag: string, v: number) {
    this.scenario.countries[tag].industry = clampIndustry(v);
    this.renderSummary();
    this.refreshRow(tag);
  }

  private setShipbuilding(tag: string, v: number) {
    this.scenario.countries[tag].shipbuilding = clampShipbuilding(v);
    this.renderSummary();
    this.refreshRow(tag);
  }

  /** Changes a country's faction; the wars are rebuilt at start (applyFactions), entry dates are shown now. */
  private setFaction(tag: string, f: Faction) {
    setFaction(this.scenario, tag, f);
    this.renderAll();
  }

  private setStability(tag: string, v: number) {
    this.scenario.countries[tag].stability = clampStability(v);
    this.renderSummary();
    this.refreshRow(tag);
    if (tag === this.selected) this.renderDetail();
  }

  // ---- rendering ----

  private renderAll() {
    this.entry = entryDates(applyFactions(this.opts.preset, this.scenario));
    this.seedInput.value = String(this.scenario.seed);
    this.renderDetail();
    this.renderSummary();
    this.renderList();
    this.drawMap();
  }

  private drawMap() {
    const { map } = this.opts;
    const sel = this.tagIndex.get(this.selected)!;
    const ownerIdx = map.states.map((s) => this.tagIndex.get(s.owner)!);
    const faction = (i: number) => this.scenario.countries[map.states[i].owner]?.faction ?? "neutral";
    const markers = cityMarkers(map, this.scenario);
    // The selected country's capital; merged into the city marker when it is a victory city (e.g. Berlin).
    const cap = capitalOf(map, this.selected);
    const city = markers.find((m) => m.state === cap);
    if (city) Object.assign(city, { label: `${city.label}(首都)`, color: "#ffd400" });
    else if (cap >= 0) markers.push({ state: cap, label: `${capitalName(this.selected)}(首都)`, color: "#ffd400", ring: "#000", labelBelow: false });
    this.renderer.draw({
      fill: (i) => this.colors[ownerIdx[i]],
      bands: {
        group: (i) => (ownerIdx[i] === sel ? 2 : faction(i) === "axis" ? 0 : faction(i) === "allies" ? 1 : -1),
        colors: [FACTION_COLORS.axis, FACTION_COLORS.allies, SELECT_COLOR],
      },
      hatched: (i) => !!this.scenario.stateOverrides?.[String(i)]?.invulnerable,
      highlight: this.hover,
      markers,
      showLabels: mapOptions().cityNames,
    });
  }

  private renderDetail() {
    const tag = this.selected;
    const c = this.scenario.countries[tag];
    const presetC = this.opts.preset.countries[tag];
    const { map } = this.opts;
    const cap = capitalOf(map, tag);
    const capState = map.states[cap];

    const historicalTotal = presetC.industry + presetC.shipbuilding;
    const multiplier = (value: number, historical: number) => historical > 0 ? value / historical : 0;
    const sliderPosition = (m: number) => String(Math.max(0, Math.min(2, m)));
    const total = el("span", { class: "production-value" });
    const totalRange = el("input", { type: "range", min: "0", max: "2", step: "0.01", "aria-label": "工業力の史実倍率" });
    totalRange.disabled = historicalTotal === 0;
    const totalMultiplier = el("span", { class: "production-multiplier" });
    const syncComponents: (() => void)[] = [];
    // Update existing controls in place so input events never interrupt a slider drag.
    const syncProduction = () => {
      const value = c.industry + c.shipbuilding;
      const m = multiplier(value, historicalTotal);
      total.textContent = fmtInd(value);
      totalRange.value = sliderPosition(m);
      totalMultiplier.textContent = `×${m.toFixed(2)}`;
      syncComponents.forEach((sync) => sync());
    };
    totalRange.oninput = () => {
      const m = Number(totalRange.value);
      c.industry = clampIndustry(presetC.industry * m);
      c.shipbuilding = clampShipbuilding(presetC.shipbuilding * m);
      this.renderSummary();
      this.refreshRow(tag);
      syncProduction();
    };
    const component = (key: "industry" | "shipbuilding", label: string, hint: string) => {
      const historical = presetC[key];
      const number = el("input", { type: "number", min: "0", max: String(INDUSTRY_MAX), step: "0.1", "aria-label": label });
      const range = el("input", { type: "range", min: "0", max: "2", step: "0.01", "aria-label": `${label}の史実倍率` });
      range.disabled = historical === 0;
      const multiple = el("span", { class: "production-multiplier" });
      const update = (value: number) => {
        if (key === "industry") this.setIndustry(tag, value);
        else this.setShipbuilding(tag, value);
        syncProduction();
      };
      number.onchange = () => update(Number(number.value));
      range.oninput = () => update(historical * Number(range.value));
      syncComponents.push(() => {
        const m = multiplier(c[key], historical);
        number.value = fmtInd(c[key]);
        range.value = sliderPosition(m);
        multiple.textContent = `×${m.toFixed(2)}`;
      });
      return [
        el("label", { class: "production-sub-label" }, label),
        el("div", { class: "field production-field production-sub-field" }, number, range, multiple,
          el("span", { class: "hint" }, `史実 ${fmtInd(historical)}${hint}`)),
      ];
    };
    const components = this.productionExpanded ? [
      ...component("industry", "陸軍生産力", "(米国 = 100)"),
      ...component("shipbuilding", "海軍生産力", "(海軍力が毎年 海軍生産力×安定性 増える)"),
    ] : [];
    const toggle = el("button", {
      type: "button", class: "btn small production-toggle", "aria-expanded": String(this.productionExpanded),
      "aria-label": "陸軍生産力と海軍生産力を表示",
    }, this.productionExpanded ? "▲" : "▼");
    toggle.onclick = () => {
      this.productionExpanded = !this.productionExpanded;
      this.renderDetail();
      this.detailEl.querySelector<HTMLButtonElement>(".production-toggle")?.focus();
    };
    syncProduction();
    const stabN = el("input", { type: "number", min: "0", max: "1", step: "0.05", value: fmtStab(c.stability), "aria-label": "政治安定性" }) as HTMLInputElement;
    const stabR = el("input", { type: "range", min: "0", max: "1", step: "0.01", value: String(c.stability), "aria-label": "政治安定性" }) as HTMLInputElement;
    stabN.onchange = () => this.setStability(tag, Number(stabN.value));
    const factionSel = el("select", { "aria-label": "陣営" },
      ...(["axis", "allies", "neutral"] as Faction[]).map((f) => {
        const o = el("option", { value: f }, FACTION_NAMES[f]);
        o.selected = f === c.faction;
        return o;
      })) as HTMLSelectElement;
    factionSel.classList.toggle("changed", c.faction !== presetC.faction);
    factionSel.onchange = () => this.setFaction(tag, factionSel.value as Faction);
    const overlord = c.overlord && this.scenario.countries[c.overlord];
    const followHint = overlord ? `・${overlord.name}の陣営に連動` : "";
    const entryDate = this.entry[tag];
    const entryHint = c.faction === "neutral" ? "・参戦しない"
      : entryDate ? `・参戦 ${entryDate.slice(0, 7).replace("-", "年")}月` : "・参戦しない";
    stabR.oninput = () => {
      stabN.value = fmtStab(Number(stabR.value));
      this.scenario.countries[tag].stability = clampStability(Number(stabR.value));
      this.renderSummary();
      this.refreshRow(tag);
    };
    this.detailEl.replaceChildren(
      el("div", { class: "detail-head" },
        el("i", { class: "swatch", style: `background:${c.color}` }),
        el("strong", {}, c.name),
        el("span", { class: `faction-badge ${c.faction}` }, FACTION_NAMES[c.faction]),
      ),
      el("div", { class: "field-grid" },
        el("div", { class: "production-label" }, toggle, icon("factory"), el("span", { class: "label-text" }, "工業力")),
        el("div", { class: "field production-field" }, total, totalRange, totalMultiplier,
          el("span", { class: "hint" }, `史実 ${fmtInd(historicalTotal)}(陸軍 ${fmtInd(presetC.industry)} + 海軍 ${fmtInd(presetC.shipbuilding)})`)),
        ...components,
        el("label", { class: "icon-label" }, icon("scale"), el("span", { class: "label-text" }, "政治安定性")),
        el("div", { class: "field" }, stabN, stabR, el("span", { class: "hint" }, `史実 ${fmtStab(presetC.stability)}`)),
        el("label", { class: "icon-label" }, icon("landmark"), el("span", { class: "label-text" }, "首都")), el("div", { class: "field" },
          capState
            ? el("span", {}, `${capitalName(tag)}（固定）`)
            : el("span", { class: "hint" }, "なし(開始時は領土を持たない)"),
          ),
        el("label", { class: "icon-label" }, icon("flag"), el("span", { class: "label-text" }, "陣営")),
        el("div", { class: "field" }, factionSel,
          el("span", { class: "hint" }, `史実 ${FACTION_NAMES[presetC.faction]}${entryHint}${followHint}`)),
      ),
    );
  }

  private renderSummary() {
    const sum = { axis: { ind: 0, mil: 0, sb: 0, n: 0 }, allies: { ind: 0, mil: 0, sb: 0, n: 0 } };
    for (const c of Object.values(this.scenario.countries)) {
      if (c.faction === "neutral") continue;
      sum[c.faction].ind += c.industry;
      sum[c.faction].mil += c.industry * c.stability;
      sum[c.faction].sb += c.shipbuilding * c.stability;
      sum[c.faction].n++;
    }
    const row = (f: "axis" | "allies") =>
      el("div", { class: "sum-row" },
        el("span", { class: `faction-badge ${f}` }, FACTION_NAMES[f]),
        el("span", {}, `${sum[f].n}か国`),
        el("span", {}, `陸軍生産力×安定性 ${fmtInd(sum[f].mil)}`),
        el("span", {}, `海軍生産力×安定性 ${fmtInd(sum[f].sb)}`));
    this.summaryEl.replaceChildren(row("axis"), row("allies"),
      el("div", { class: "hint" }, "参戦日が来るまで戦わない国も含む。年間の伸びは、陸軍力が 陸軍生産力 × 安定性 にほぼ比例し、海軍力は 海軍生産力 × 安定性。"));
  }

  private renderList() {
    const q = this.query;
    const tags = Object.keys(this.scenario.countries)
      .filter((t) => this.filter === "all" || this.scenario.countries[t].faction === this.filter)
      .filter((t) => !q || this.scenario.countries[t].name.includes(q) || t.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => {
        const ca = this.scenario.countries[a], cb = this.scenario.countries[b];
        return (cb.industry + cb.shipbuilding) - (ca.industry + ca.shipbuilding) || a.localeCompare(b);
      });
    const head = el("div", { class: "row head" },
      el("span", {}, "国"), el("span", {}, "陣営"), el("span", {}, "参戦"), el("span", {}, "工業力"), el("span", {}, "安定性"));
    this.listEl.replaceChildren(head, ...tags.map((t) => this.makeRow(t)));
  }

  private makeRow(tag: string): HTMLElement {
    const c = this.scenario.countries[tag];
    const ind = el("span", { class: "production-total" }, fmtInd(c.industry + c.shipbuilding));
    const stab = el("input", { type: "number", min: "0", max: "1", step: "0.05", value: fmtStab(c.stability), "aria-label": `${c.name}の政治安定性` }) as HTMLInputElement;
    stab.onchange = () => this.setStability(tag, Number(stab.value));
    stab.onclick = (e) => e.stopPropagation();
    const date = this.entry[tag];
    const row = el("div", { class: `row ${tag === this.selected ? "selected" : ""}`, "data-tag": tag },
      el("span", { class: "name" }, el("i", { class: "swatch", style: `background:${c.color}` }), c.name),
      el("span", { class: `faction-badge ${c.faction}` }, FACTION_NAMES[c.faction]),
      el("span", { class: "date" }, date ? date.slice(0, 7).replace("-", "年") + "月" : "—"),
      ind, stab);
    row.onclick = () => this.select(tag);
    this.markChanged(row, tag);
    return row;
  }

  private refreshRow(tag: string) {
    const row = this.listEl.querySelector<HTMLElement>(`[data-tag="${tag}"]`);
    if (!row) return;
    const c = this.scenario.countries[tag];
    row.querySelector(".production-total")!.textContent = fmtInd(c.industry + c.shipbuilding);
    const stab = row.querySelector("input")!;
    if (document.activeElement !== stab) stab.value = fmtStab(c.stability);
    this.markChanged(row, tag);
  }

  /** Values that differ from the historical preset are marked. */
  private markChanged(row: HTMLElement, tag: string) {
    const c = this.scenario.countries[tag], p = this.opts.preset.countries[tag];
    const stab = row.querySelector("input")!;
    row.querySelector(".production-total")!.classList.toggle("changed", c.industry + c.shipbuilding !== p.industry + p.shipbuilding);
    stab.classList.toggle("changed", c.stability !== p.stability);
    row.querySelector(".faction-badge")!.classList.toggle("changed", c.faction !== p.faction);
  }
}
