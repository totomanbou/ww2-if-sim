import "./style.css";
import { loadHistoricalPreset, loadMap } from "./data";
import type { MapData } from "./sim/mapTypes";
import type { Scenario, SimState } from "./sim/types";
import { ObserveScreen } from "./ui/observe";
import { ResultScreen } from "./ui/result";
import { SetupScreen, type SetupState } from "./ui/setup";

const app = document.getElementById("app")!;

/** Screen flow: setup → observation → result → (re-run with another seed | back to setup with the same edits). */
class App {
  private screen: { destroy(): void } | null = null;
  /** Setup screen state, kept while observing so "back" resumes the same edits. */
  private setupState: SetupState | null = null;

  constructor(private map: MapData, private preset: Scenario) {}

  showSetup() {
    this.screen?.destroy();
    const setup = new SetupScreen(app, {
      map: this.map,
      preset: this.preset,
      initial: this.setupState ?? undefined,
      onStart: (scenario) => {
        this.setupState = setup.getState();
        this.showObserve(scenario);
      },
    });
    this.screen = setup;
    expose({ setup });
  }

  showObserve(scenario: Scenario) {
    this.screen?.destroy();
    const observe = new ObserveScreen(app, {
      map: this.map,
      scenario,
      seed: scenario.seed,
      onBack: () => this.showSetup(),
      onResult: (sim) => this.showResult(sim),
    });
    this.screen = observe;
    expose({ observe });
  }

  showResult(sim: SimState) {
    this.screen?.destroy();
    const result = new ResultScreen(app, {
      map: this.map,
      sim,
      onRerun: () => this.showObserve({ ...sim.scenario, seed: newSeed(sim.seed) }),
      onSetup: () => this.showSetup(),
    });
    this.screen = result;
    expose({ result });
  }
}

/** A random seed different from the current one. */
function newSeed(current: number): number {
  let s = current;
  while (s === current) s = Math.floor(Math.random() * 1_000_000_000);
  return s;
}

/** Debug handles for the browser console. */
function expose(o: object) {
  Object.assign(window as unknown as Record<string, unknown>, { __app: o });
}

async function main() {
  app.textContent = "読み込み中…";
  const [map, preset] = await Promise.all([loadMap(), loadHistoricalPreset()]);
  app.textContent = "";
  new App(map, preset).showSetup();
}

main().catch((e) => {
  app.textContent = `読み込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`;
});
