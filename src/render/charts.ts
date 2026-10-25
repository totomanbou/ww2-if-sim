export interface Series {
  label: string;
  color: string;
  values: number[];
}

export interface LineChartOptions {
  title: string;
  /** Total number of x slots (ticks) the axis spans, so the chart does not rescale as data grows. */
  xMax: number;
  /** Tick labels on the x axis: [x index, label]. */
  xTicks: [number, string][];
}

/** Minimal Canvas 2D line chart (no dependencies). Redraw with draw(series) whenever data changes. */
export class LineChart {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private last: Series[] = [];

  constructor(container: HTMLElement, private opts: LineChartOptions) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "chart-canvas";
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  private resize() {
    const r = this.canvas.parentElement!.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.draw(this.last);
  }

  draw(series: Series[]) {
    this.last = series;
    const { ctx, dpr } = this;
    const W = this.canvas.width, H = this.canvas.height;
    const css = getComputedStyle(this.canvas);
    const fg = css.getPropertyValue("--chart-fg").trim() || "#ccc";
    const grid = css.getPropertyValue("--chart-grid").trim() || "rgba(255,255,255,0.12)";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const padL = 40 * dpr, padR = 8 * dpr, padT = 20 * dpr, padB = 18 * dpr;
    const pw = W - padL - padR, ph = H - padT - padB;
    if (pw <= 0 || ph <= 0) return;

    let yMax = 0;
    for (const s of series) for (const v of s.values) if (v > yMax) yMax = v;
    yMax = niceCeil(yMax || 1);
    const X = (i: number) => padL + (i / Math.max(1, this.opts.xMax)) * pw;
    const Y = (v: number) => padT + ph - (v / yMax) * ph;

    ctx.font = `${10 * dpr}px system-ui, sans-serif`;
    ctx.fillStyle = fg;
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    for (let k = 0; k <= 4; k++) {
      const v = (yMax * k) / 4, y = Math.round(Y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(W - padR, y);
      ctx.stroke();
      ctx.fillText(formatNum(v), padL - 4 * dpr, y);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const [i, label] of this.opts.xTicks) ctx.fillText(label, X(i), padT + ph + 4 * dpr);

    ctx.lineWidth = 1.8 * dpr;
    ctx.lineJoin = "round";
    for (const s of series) {
      if (!s.values.length) continue;
      ctx.strokeStyle = s.color;
      ctx.beginPath();
      s.values.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
      ctx.stroke();
    }

    // Title and legend with the latest values.
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = `600 ${11 * dpr}px system-ui, sans-serif`;
    ctx.fillStyle = fg;
    ctx.fillText(this.opts.title, padL, 3 * dpr);
    let x = padL + ctx.measureText(this.opts.title).width + 12 * dpr;
    ctx.font = `${11 * dpr}px system-ui, sans-serif`;
    for (const s of series) {
      const last = s.values.length ? s.values[s.values.length - 1] : 0;
      const text = `${s.label} ${formatNum(last)}`;
      ctx.fillStyle = s.color;
      ctx.fillRect(x, 6 * dpr, 10 * dpr, 3 * dpr);
      ctx.fillStyle = fg;
      ctx.fillText(text, x + 14 * dpr, 3 * dpr);
      x += ctx.measureText(text).width + 26 * dpr;
    }
  }
}

function niceCeil(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function formatNum(v: number): string {
  return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
}
