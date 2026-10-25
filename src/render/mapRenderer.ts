import type { MapData } from "../sim/mapTypes";

export interface MapMarker {
  state: number;
  at?: [number, number];
  label: string;
  color: string;
  ring?: string;
  labelBelow?: boolean;
  kind?: "important";
}

export interface DrawStyle {
  /** Fill colour per state id. */
  fill: (id: number) => string;
  /**
   * Group boundaries (e.g. factions): a band in colors[group] is drawn just inside the edge of each
   * group's territory wherever it meets another group or the sea. group < 0 or a null colour = no band.
   */
  bands?: { group: (id: number) => number; colors: (string | null)[] };
  /** States drawn with a diagonal hatch on top of the fill. */
  hatched?: (id: number) => boolean;
  showSeaRoutes?: boolean;
  highlight?: number | null;
  /** Point markers at state centres with a label (constant on-screen size). */
  markers?: MapMarker[];
  /** Draw the markers' labels (default true); false keeps only the points (mapOptions.cityNames). */
  showLabels?: boolean;
  /** Small boxes at map positions (map units) with coloured text lines, e.g. fleets per sea zone. */
  badges?: { at: [number, number]; lines: { text: string; color: string }[] }[];
}

/**
 * Canvas 2D map renderer. Each state is a cached Path2D in map units; a full redraw
 * fills ~4,000 paths, which is cheap enough to run on every simulation tick.
 */
export class MapRenderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private paths: Path2D[];
  /** All state outlines in one path (static, built once). */
  private borders: Path2D;
  /** Bounding boxes [minX, minY, maxX, maxY] per state, for fast hit tests. */
  private bbox: Float64Array;
  /** Ring segments as x1, y1, x2, y2 with the states on each side (b = -1: coast or unmatched). */
  private segs: { xy: Float64Array; a: Int32Array; b: Int32Array } | null = null;
  /**
   * Fill paths per colour for each zoom level (see level()), rebuilt only when some state's colour changes. They are
   * built from the states' paths decimated for that level (levelPaths).
   */
  private fillCaches = new Map<number, { colors: string[]; byColor: Map<string, Path2D> }>();
  /** State paths with vertices closer than about one device pixel dropped, per zoom level (built when first used). */
  private levelPaths = new Map<number, Path2D[]>();
  /** All state outlines per zoom level, from levelPaths. */
  private levelBorders = new Map<number, Path2D>();
  /**
   * Band geometry per group, rebuilt only when some state's group or colour changes: the boundary as chained
   * polylines (map units) and their decimated paths per zoom level.
   */
  private bandCache: { groups: Int32Array; lines: Float64Array[][]; lod: Map<number, Path2D[]> } | null = null;
  /** A redraw requested by input, run once on the next animation frame. */
  private drawPending = false;
  /**
   * While zooming or panning, the last full drawing is shown scaled and moved (snap, with the transform it was drawn
   * with); the map is drawn again in full GESTURE_SETTLE_MS after the last input event.
   */
  private snap: HTMLCanvasElement | null = null;
  private snapT = { scale: 1, ox: 0, oy: 0 };
  /** Time of the last full drawing (render). */
  private lastRenderAt = 0;
  private gestureUntil = 0;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  scale = 1;
  ox = 0;
  oy = 0;
  private dpr = 1;
  private hatch: CanvasPattern | null = null;
  private lastStyle: DrawStyle | null = null;
  /** Duration of the last draw() in ms. */
  lastDrawMs = 0;
  onClickState: ((id: number) => void) | null = null;
  onHoverState: ((id: number | null) => void) | null = null;

  constructor(private map: MapData, container: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "map-canvas";
    // Absolute so the canvas never feeds back into the container size observed below.
    this.canvas.style.position = "absolute";
    this.canvas.style.left = this.canvas.style.top = "0";
    this.canvas.style.touchAction = "none";
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this.paths = map.states.map((s) => {
      const p = new Path2D();
      for (const r of s.rings) {
        p.moveTo(r[0], r[1]);
        for (let k = 2; k < r.length; k += 2) p.lineTo(r[k], r[k + 1]);
        p.closePath();
      }
      return p;
    });
    this.borders = new Path2D();
    for (const p of this.paths) this.borders.addPath(p);
    this.bbox = new Float64Array(map.states.length * 4);
    map.states.forEach((s, i) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const r of s.rings) for (let k = 0; k < r.length; k += 2) {
        x0 = Math.min(x0, r[k]); x1 = Math.max(x1, r[k]);
        y0 = Math.min(y0, r[k + 1]); y1 = Math.max(y1, r[k + 1]);
      }
      this.bbox.set([x0, y0, x1, y1], i * 4);
    });
    new ResizeObserver(() => this.resize()).observe(container);
    this.attachInput();
    this.resize();
  }

  private makeHatch(): CanvasPattern | null {
    const c = document.createElement("canvas");
    c.width = c.height = 8;
    const g = c.getContext("2d")!;
    g.strokeStyle = "rgba(0,0,0,0.55)";
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(0, 8);
    g.lineTo(8, 0);
    g.moveTo(-2, 2);
    g.lineTo(2, -2);
    g.moveTo(6, 10);
    g.lineTo(10, 6);
    g.stroke();
    return this.ctx.createPattern(c, "repeat");
  }

  resize() {
    const r = this.canvas.parentElement!.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.fit();
  }

  /** Fit the whole map into the canvas. */
  fit() {
    const s = Math.min(this.canvas.width / this.map.width, this.canvas.height / this.map.height);
    this.scale = s;
    this.ox = (this.canvas.width - this.map.width * s) / 2;
    this.oy = (this.canvas.height - this.map.height * s) / 2;
    this.gestureUntil = 0;
    if (this.lastStyle) this.render(this.lastStyle);
  }

  /** Map units from a client (CSS pixel) position. */
  toMap(clientX: number, clientY: number): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [((clientX - r.left) * this.dpr - this.ox) / this.scale, ((clientY - r.top) * this.dpr - this.oy) / this.scale];
  }

  stateAt(clientX: number, clientY: number): number | null {
    // The map wraps east-west: any copy maps back onto the original.
    const [mx, y] = this.toMap(clientX, clientY);
    const x = ((mx % this.map.width) + this.map.width) % this.map.width;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    const b = this.bbox;
    for (let i = 0; i < this.paths.length; i++) {
      if (x < b[i * 4] || y < b[i * 4 + 1] || x > b[i * 4 + 2] || y > b[i * 4 + 3]) continue;
      if (this.ctx.isPointInPath(this.paths[i], x, y, "evenodd")) return i;
    }
    return null;
  }

  /** Zoom to scale `ns` (clamped to the fit scale … 40×) keeping device pixel (px, py) over the same map point. */
  private zoomAt(px: number, py: number, ns: number) {
    const minScale = Math.min(this.canvas.width / this.map.width, this.canvas.height / this.map.height);
    ns = Math.min(minScale * 40, Math.max(minScale, ns));
    this.ox = px - ((px - this.ox) * ns) / this.scale;
    this.oy = py - ((py - this.oy) * ns) / this.scale;
    this.scale = ns;
  }

  private attachInput() {
    let drag: { x: number; y: number; moved: boolean } | null = null;
    // Pointers currently down (client coordinates), for two-finger pinch zoom on touch screens.
    const down = new Map<number, { x: number; y: number }>();
    // During a pinch: the previous finger distance and midpoint (client px).
    let pinch: { dist: number; mx: number; my: number } | null = null;
    // Double tap on touch screens fits the map (dblclick is not fired reliably for touch).
    let lastTap = { t: 0, x: 0, y: 0 };
    const devicePoint = (x: number, y: number) => {
      const r = this.canvas.getBoundingClientRect();
      return [(x - r.left) * this.dpr, (y - r.top) * this.dpr];
    };
    const twoFingers = () => {
      const [a, b] = [...down.values()];
      return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    };
    this.canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const [px, py] = devicePoint(e.clientX, e.clientY);
      this.zoomAt(px, py, this.scale * Math.exp(-e.deltaY * 0.0015));
      this.requestDraw();
    }, { passive: false });
    this.canvas.addEventListener("pointerdown", (e) => {
      down.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.canvas.setPointerCapture(e.pointerId);
      if (down.size === 2) {
        // A second finger turns the drag into a pinch (and never into a click).
        pinch = twoFingers();
        drag = null;
      } else if (down.size === 1) {
        drag = { x: e.clientX, y: e.clientY, moved: false };
      }
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (down.has(e.pointerId)) down.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && down.size >= 2) {
        // Zoom by the change in finger distance about the midpoint, and pan by the midpoint's movement.
        const now = twoFingers();
        const [px, py] = devicePoint(now.mx, now.my);
        this.ox += (now.mx - pinch.mx) * this.dpr;
        this.oy += (now.my - pinch.my) * this.dpr;
        if (pinch.dist > 0 && now.dist > 0) this.zoomAt(px, py, this.scale * (now.dist / pinch.dist));
        pinch = now;
        this.requestDraw();
      } else if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        if (drag.moved) {
          this.ox += dx * this.dpr;
          this.oy += dy * this.dpr;
          drag.x = e.clientX;
          drag.y = e.clientY;
          this.requestDraw();
        }
      } else if (this.onHoverState && e.pointerType !== "touch") {
        this.onHoverState(this.stateAt(e.clientX, e.clientY));
      }
    });
    const release = (e: PointerEvent) => {
      down.delete(e.pointerId);
      if (pinch) {
        // Lifting one finger of a pinch continues as a drag with the other (already "moved": no click).
        if (down.size < 2) pinch = null;
        const rest = [...down.values()][0];
        drag = rest ? { x: rest.x, y: rest.y, moved: true } : null;
        return;
      }
      if (e.type === "pointerup" && drag && !drag.moved) {
        if (e.pointerType === "touch") {
          const t = performance.now();
          if (t - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
            lastTap.t = 0;
            drag = null;
            this.fit();
            return;
          }
          lastTap = { t, x: e.clientX, y: e.clientY };
        }
        if (this.onClickState) {
          const id = this.stateAt(e.clientX, e.clientY);
          if (id !== null) this.onClickState(id);
        }
      }
      drag = null;
    };
    this.canvas.addEventListener("pointerup", release);
    this.canvas.addEventListener("pointercancel", release);
    this.canvas.addEventListener("dblclick", () => this.fit());
  }

  /**
   * Redraw on the next animation frame. Wheel and drag events can arrive several times per frame; drawing each one
   * synchronously redrew the whole map several times a frame.
   */
  private requestDraw() {
    if (!this.lastStyle) return;
    this.gestureUntil = performance.now() + GESTURE_SETTLE_MS;
    this.scheduleSettle();
    if (this.drawPending) return;
    this.drawPending = true;
    requestAnimationFrame(() => {
      this.drawPending = false;
      // During any gesture (zoom in, zoom out, drag) the map is drawn in full every GESTURE_REFRESH_MS (user
      // requirement); the frames in between show the previous drawing scaled and moved.
      if (performance.now() - this.lastRenderAt >= GESTURE_REFRESH_MS && this.lastStyle) {
        this.render(this.lastStyle);
      } else this.drawQuick();
    });
  }

  /** All state outlines for the current zoom level (the full path from scale 1 up). */
  private bordersAt(): Path2D {
    if (this.scale >= 1) return this.borders;
    const level = this.level();
    let b = this.levelBorders.get(level);
    if (!b) {
      b = new Path2D();
      for (const p of this.statePaths()) b.addPath(p);
      this.levelBorders.set(level, b);
    }
    return b;
  }

  /** Zoom level: half-octaves of scale (shared by the decimated fill and band paths). */
  private level(): number {
    return this.curLevel;
  }
  /** The zoom level used by the current drawing (chosen at the start of render, see pickLevel). */
  private curLevel = 0;

  /**
   * The zoom level for a drawing: half-octaves of scale. During a gesture a level whose state paths are not built yet
   * is not built then (that stalled zooming in for up to a second): the nearest built level is used instead, slightly
   * coarser or finer, and the exact level is built when the gesture settles (or earlier in idle time, prebuildLevels).
   */
  private pickLevel(): number {
    const target = Math.floor(Math.log2(this.scale) * 2);
    if (this.scale >= 1 || this.levelPaths.has(target) || performance.now() >= this.gestureUntil) return target;
    let best: number | null = null;
    for (const l of this.levelPaths.keys()) if (best === null || Math.abs(l - target) < Math.abs(best - target)) best = l;
    return best ?? target;
  }

  /** Builds the state paths of every zoom level below scale 1, one level per idle period. */
  private prebuildLevels() {
    if (this.prebuildStarted) return;
    this.prebuildStarted = true;
    const fitLevel = Math.floor(Math.log2(Math.min(this.canvas.width / this.map.width, this.canvas.height / this.map.height)) * 2);
    const todo: number[] = [];
    for (let l = fitLevel - 1; l < 0; l++) todo.push(l);
    const idle = (cb: () => void) =>
      "requestIdleCallback" in window ? window.requestIdleCallback(cb, { timeout: 2000 }) : setTimeout(cb, 50);
    const next = () => {
      const l = todo.shift();
      if (l === undefined) return;
      if (!this.levelPaths.has(l)) this.buildLevel(l);
      idle(next);
    };
    idle(next);
  }
  private prebuildStarted = false;

  /**
   * State paths for the current zoom level, with vertices closer than about one device pixel dropped (rings smaller
   * than that are left out). From scale 1 up the full paths are used.
   */
  private statePaths(): Path2D[] {
    if (this.scale >= 1) return this.paths;
    return this.levelPaths.get(this.level()) ?? this.buildLevel(this.level());
  }

  private buildLevel(level: number): Path2D[] {
    let paths = this.levelPaths.get(level);
    if (!paths) {
      const tol = 1 / 2 ** (level / 2), tol2 = tol * tol;
      paths = this.map.states.map((s) => {
        const p = new Path2D();
        for (const r of s.rings) {
          const pts: number[] = [r[0], r[1]];
          let lx = r[0], ly = r[1];
          for (let k = 2; k < r.length; k += 2) {
            if ((r[k] - lx) ** 2 + (r[k + 1] - ly) ** 2 < tol2) continue;
            pts.push(r[k], r[k + 1]);
            lx = r[k]; ly = r[k + 1];
          }
          if (pts.length < 6) continue; // smaller than about a pixel
          p.moveTo(pts[0], pts[1]);
          for (let k = 2; k < pts.length; k += 2) p.lineTo(pts[k], pts[k + 1]);
          p.closePath();
        }
        return p;
      });
      this.levelPaths.set(level, paths);
    }
    return paths;
  }

  /** Full redraw once input has been quiet for GESTURE_SETTLE_MS. */
  private scheduleSettle() {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.gestureUntil = 0;
      if (this.lastStyle) this.render(this.lastStyle);
    }, GESTURE_SETTLE_MS);
  }

  /** The last full drawing, scaled and moved to the current view (cheap: one drawImage). */
  private drawQuick() {
    if (!this.snap || this.snap.width !== this.canvas.width || this.snap.height !== this.canvas.height) {
      if (this.lastStyle) this.render(this.lastStyle);
      return;
    }
    const { ctx } = this, k = this.scale / this.snapT.scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = getComputedStyle(this.canvas).getPropertyValue("--sea").trim() || "#a9c4d6";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(k, 0, 0, k, this.ox - this.snapT.ox * k, this.oy - this.snapT.oy * k);
    ctx.drawImage(this.snap, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /**
   * Chains boundary segments (indices into segs) into polylines by their shared end points, so a band is stroked as
   * a few long lines instead of thousands of separate short segments.
   */
  private chain(ids: number[]): Float64Array[] {
    const xy = this.segs!.xy;
    const key = (x: number, y: number) => y * 16384 + x;
    const at = new Map<number, number[]>();
    for (const k of ids) {
      for (const e of [0, 1]) {
        const p = key(xy[k * 4 + e * 2], xy[k * 4 + e * 2 + 1]);
        const l = at.get(p);
        if (l) l.push(k); else at.set(p, [k]);
      }
    }
    const used = new Set<number>();
    const out: Float64Array[] = [];
    // From the end point (x, y), follow unused segments and append their far ends.
    const walk = (x: number, y: number, pts: number[]) => {
      for (;;) {
        const next = at.get(key(x, y))?.find((k) => !used.has(k));
        if (next === undefined) return;
        used.add(next);
        const fwd = xy[next * 4] === x && xy[next * 4 + 1] === y;
        x = fwd ? xy[next * 4 + 2] : xy[next * 4];
        y = fwd ? xy[next * 4 + 3] : xy[next * 4 + 1];
        pts.push(x, y);
      }
    };
    for (const k of ids) {
      if (used.has(k)) continue;
      used.add(k);
      const head: number[] = [], tail: number[] = [xy[k * 4], xy[k * 4 + 1], xy[k * 4 + 2], xy[k * 4 + 3]];
      walk(xy[k * 4 + 2], xy[k * 4 + 3], tail);
      walk(xy[k * 4], xy[k * 4 + 1], head);
      const pts: number[] = [];
      for (let i = head.length - 2; i >= 0; i -= 2) pts.push(head[i], head[i + 1]);
      out.push(Float64Array.from([...pts, ...tail]));
    }
    return out;
  }

  /**
   * Band paths for the current zoom: the chained polylines with vertices closer than about three device pixels dropped
   * (cached per half-octave of scale). Zoomed out, the full-detail boundary has thousands of vertices per pixel row,
   * and stroking it at band width was the main cost of a redraw.
   */
  private bandPaths(): Path2D[] {
    const bc = this.bandCache!;
    const level = this.level();
    let paths = bc.lod.get(level);
    if (!paths) {
      const tol = 3 / 2 ** (level / 2), tol2 = tol * tol; // about 3 device pixels (the band is 5 px wide)
      paths = bc.lines.map((lines) => {
        const p = new Path2D();
        for (const l of lines) {
          let lx = l[0], ly = l[1];
          p.moveTo(lx, ly);
          for (let i = 2; i < l.length; i += 2) {
            const x = l[i], y = l[i + 1], last = i === l.length - 2;
            if (!last && (x - lx) ** 2 + (y - ly) ** 2 < tol2) continue;
            p.lineTo(x, y);
            lx = x; ly = y;
          }
        }
        return p;
      });
      bc.lod.set(level, paths);
    }
    return paths;
  }

  /**
   * Shared borders have identical vertices on both sides (TopoJSON shared arcs), so a segment seen in
   * two states' rings is an internal border; one seen once is a coast.
   */
  private buildSegments() {
    const key = (x1: number, y1: number, x2: number, y2: number) => {
      const p = y1 * 16384 + x1, q = y2 * 16384 + x2;
      return p < q ? p * 67108864 + q : q * 67108864 + p;
    };
    const seen = new Map<number, number>();
    const xy: number[] = [], a: number[] = [], b: number[] = [];
    this.map.states.forEach((s, id) => {
      for (const r of s.rings) {
        const n = r.length;
        for (let k = 0; k < n; k += 2) {
          const x1 = r[k], y1 = r[k + 1], x2 = r[(k + 2) % n], y2 = r[(k + 3) % n];
          if (x1 === x2 && y1 === y2) continue;
          const kk = key(x1, y1, x2, y2);
          const j = seen.get(kk);
          if (j !== undefined && a[j] !== id && b[j] < 0) { b[j] = id; continue; }
          seen.set(kk, a.length);
          xy.push(x1, y1, x2, y2);
          a.push(id);
          b.push(-1);
        }
      }
    });
    this.segs = { xy: Float64Array.from(xy), a: Int32Array.from(a), b: Int32Array.from(b) };
  }

  /**
   * Draws the map with `style`. During a zoom or pan gesture the full drawing is deferred until the gesture settles
   * (the view shows the scaled previous drawing meanwhile).
   */
  draw(style: DrawStyle) {
    this.lastStyle = style;
    if (performance.now() < this.gestureUntil) {
      this.scheduleSettle();
      return;
    }
    this.render(style);
  }

  /** Offscreen canvases by use: "band" for drawing bands, "world" for one copy of the map (see render). */
  private layers = new Map<string, HTMLCanvasElement>();
  private offscreen(name: string, width: number, height: number): HTMLCanvasElement {
    let c = this.layers.get(name);
    if (!c) this.layers.set(name, (c = document.createElement("canvas")));
    if (c.width !== width || c.height !== height) {
      c.width = width;
      c.height = height;
    }
    return c;
  }

  /**
   * The map wraps east-west (user requirement: the Pacific was split at the map's edge): horizontal copies, as offsets
   * k in map widths, that are at least partly on screen. Mercator's straight date-line edges meet at every latitude.
   */
  private copies(): number[] {
    const w = this.map.width * this.scale;
    const out: number[] = [];
    for (let k = Math.floor(-this.ox / w) - 1; this.ox + k * w < this.canvas.width; k++) if (this.ox + (k + 1) * w > 0) out.push(k);
    return out;
  }

  /**
   * Draws the land layers (fills, hatching, borders, faction bands) onto `ctx`, a canvas of width × height device
   * pixels, once for each copy of the map whose left edge is at device x in `xs` (top edge at device y).
   */
  private drawLand(
    ctx: CanvasRenderingContext2D, xs: number[], y: number, style: DrawStyle,
    fill: { colors: string[]; byColor: Map<string, Path2D> }, width: number, height: number,
  ) {
    const { paths } = this;
    const at = (x: number) => ctx.setTransform(this.scale, 0, 0, this.scale, x, y);
    const px = 1 / this.scale; // one device pixel in map units

    // Band groups per state, and the band group of each fill colour (-1: none).
    const bands = style.bands;
    const g = bands ? Int32Array.from(paths, (_, i) => bands.group(i)) : null;
    const colorGroup = new Map<string, number>();
    if (g && bands) for (let i = 0; i < paths.length; i++) if (g[i] >= 0 && bands.colors[g[i]]) colorGroup.set(fill.colors[i], g[i]);

    const fillColors = (c2: CanvasRenderingContext2D, gi: number) => {
      for (const x of xs) {
        c2.setTransform(this.scale, 0, 0, this.scale, x, y);
        for (const [c, p] of fill.byColor) {
          if ((colorGroup.get(c) ?? -1) !== gi) continue;
          c2.fillStyle = c;
          c2.fill(p, "evenodd");
        }
      }
    };
    fillColors(ctx, -1);

    if (bands && g) {
      if (!this.segs) this.buildSegments();
      const { a, b } = this.segs!;
      const { colors } = bands;
      const bc = this.bandCache;
      const sameGroups = (x: Int32Array) => x.length === g.length && !x.some((v, i) => v !== g[i]);
      // Boundary polylines: rebuilt only when some state's group changes.
      if (!bc || bc.lines.length !== colors.length || !sameGroups(bc.groups)) {
        const edgeIds: number[][] = colors.map(() => []);
        for (let k = 0; k < a.length; k++) {
          const ga = g[a[k]], gb = b[k] >= 0 ? g[b[k]] : -1;
          if (ga === gb) continue;
          for (const gg of [ga, gb]) {
            if (gg < 0 || !colors[gg]) continue;
            edgeIds[gg].push(k);
          }
        }
        this.bandCache = { groups: g, lines: edgeIds.map((ids) => this.chain(ids)), lod: new Map() };
      }
      const edge = this.bandPaths();
      // Each group's countries are filled on a layer of their own and the band, stroked at double width over it with
      // "source-atop", only shows on the group's own area (the inner half); the layer then goes onto the target.
      // (Clipping to the group's area, or a second fill of it with "destination-in", cost more than all the fills.)
      const layer = this.offscreen("band", width, height);
      const lctx = layer.getContext("2d")!;
      lctx.lineJoin = "round";
      colors.forEach((c, gi) => {
        if (!c) return;
        lctx.setTransform(1, 0, 0, 1, 0, 0);
        lctx.globalCompositeOperation = "source-over";
        lctx.clearRect(0, 0, layer.width, layer.height);
        fillColors(lctx, gi);
        lctx.globalCompositeOperation = "source-atop";
        lctx.strokeStyle = c;
        lctx.lineWidth = 5 * px;
        for (const x of xs) {
          lctx.setTransform(this.scale, 0, 0, this.scale, x, y);
          lctx.stroke(edge[gi]);
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(layer, 0, 0);
      });
    }

    if (style.hatched) {
      const hp = new Path2D();
      let any = false;
      for (let i = 0; i < paths.length; i++) if (style.hatched(i)) { hp.addPath(paths[i]); any = true; }
      if (any && this.hatch) {
        // Keep the hatch at a constant on-screen size regardless of zoom.
        this.hatch.setTransform(new DOMMatrix().scale(1 / this.scale));
        ctx.fillStyle = this.hatch;
        for (const x of xs) { at(x); ctx.fill(hp, "evenodd"); }
      }
    }

    // State borders: thin, only when zoomed enough to be readable.
    if (this.scale > 0.18) {
      ctx.strokeStyle = "rgba(0,0,0,0.18)";
      ctx.lineWidth = 0.6 * px;
      const borders = this.bordersAt();
      for (const x of xs) { at(x); ctx.stroke(borders); }
    }

    if (bands) {
      // A thin dark line on the boundary itself makes the bands read as frames.
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.lineWidth = 0.8 * px;
      for (const x of xs) { at(x); for (const e of this.bandPaths()) ctx.stroke(e); }
    }
  }

  private render(style: DrawStyle) {
    const t = performance.now();
    this.lastStyle = style;
    this.curLevel = this.pickLevel();
    const { ctx, paths, map } = this;
    if (!this.hatch) this.hatch = this.makeHatch();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = getComputedStyle(this.canvas).getPropertyValue("--sea").trim() || "#a9c4d6";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const ks = this.copies(), W = map.width;
    /** Map units of copy k to device pixels. */
    const at = (k: number) => ctx.setTransform(this.scale, 0, 0, this.scale, this.ox + k * W * this.scale, this.oy);
    at(0);

    // Batch fills by colour: one fill() per colour instead of per state.
    // Only colours whose set of states changed are rebuilt (a few countries per tick).
    const fillColors = paths.map((_, i) => style.fill(i));
    const lp = this.statePaths(), lvl = this.scale >= 1 ? 99 : this.level();
    const fc = this.fillCaches.get(lvl);
    const dirty = new Set<string>();
    if (!fc) for (const c of fillColors) dirty.add(c);
    else fillColors.forEach((c, i) => { if (c !== fc.colors[i]) { dirty.add(c); dirty.add(fc.colors[i]); } });
    if (dirty.size) {
      const byColor = new Map(fc?.byColor ?? []);
      for (const c of dirty) byColor.set(c, new Path2D());
      for (let i = 0; i < paths.length; i++) if (dirty.has(fillColors[i])) byColor.get(fillColors[i])!.addPath(lp[i]);
      for (const c of dirty) if (!fillColors.includes(c)) byColor.delete(c);
      this.fillCaches.set(lvl, { colors: fillColors, byColor });
    }
    const fill = this.fillCaches.get(lvl)!;

    // Land layers (fills, hatching, borders, bands). With several copies on screen, they are drawn once onto an
    // offscreen canvas holding one copy of the map, which is then copied for each copy (performance: drawing every
    // copy's paths tripled the cost of a redraw at world zoom).
    const sw = W * this.scale, sh = map.height * this.scale;
    const fx = this.ox - Math.floor(this.ox), fy = this.oy - Math.floor(this.oy);
    const ww = Math.ceil(sw + fx), wh = Math.ceil(sh + fy);
    if (ks.length > 1 && ww * wh <= MAX_WORLD_PIXELS) {
      const world = this.offscreen("world", ww, wh);
      const wctx = world.getContext("2d")!;
      wctx.setTransform(1, 0, 0, 1, 0, 0);
      wctx.clearRect(0, 0, ww, wh);
      this.drawLand(wctx, [fx], fy, style, fill, ww, wh);
      // Whole device pixels, so the copy is not resampled (copies may shift by up to half a pixel).
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      for (const k of ks) ctx.drawImage(world, Math.floor(this.ox) + Math.round(k * sw), Math.floor(this.oy));
    } else {
      this.drawLand(ctx, ks.map((k) => this.ox + k * sw), this.oy, style, fill, this.canvas.width, this.canvas.height);
    }
    at(0);
    const px = 1 / this.scale; // one device pixel in map units

    if (style.showSeaRoutes) {
      ctx.lineWidth = 1 * px;
      for (const k of ks) {
        at(k);
        for (const r of map.seaRoutes) {
          const a = map.states[r.a].center, b = map.states[r.b].center;
          ctx.strokeStyle = r.src === "manual" ? "rgba(160,40,40,0.8)" : "rgba(20,60,140,0.6)";
          ctx.beginPath();
          // A route across the antimeridian runs on into the neighbouring copy of the map.
          const bx = Math.abs(a[0] - b[0]) > W / 2 ? b[0] + (a[0] > b[0] ? W : -W) : b[0];
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(bx, b[1]);
          ctx.stroke();
        }
      }
    }

    if (style.highlight != null) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2.5 * px;
      for (const k of ks) { at(k); ctx.stroke(paths[style.highlight]); }
    }

    if (style.badges?.length) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const fontPx = 11 * this.dpr, pad = 3 * this.dpr, lh = fontPx * 1.25;
      ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
      ctx.textBaseline = "top";
      for (const b of style.badges.flatMap((bd) => ks.map((k) => ({ ...bd, dx: k * W * this.scale })))) {
        if (!b.lines.length) continue;
        const x = b.at[0] * this.scale + this.ox + b.dx, y = b.at[1] * this.scale + this.oy;
        const w = Math.max(...b.lines.map((l) => ctx.measureText(l.text).width)) + pad * 2;
        const h = lh * b.lines.length + pad * 2;
        ctx.fillStyle = "rgba(15,18,22,0.82)";
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.lineWidth = this.dpr;
        ctx.beginPath();
        ctx.roundRect(x - w / 2, y - h / 2, w, h, 3 * this.dpr);
        ctx.fill();
        ctx.stroke();
        b.lines.forEach((l, i) => {
          ctx.fillStyle = l.color;
          ctx.fillText(l.text, x - w / 2 + pad, y - h / 2 + pad + i * lh);
        });
      }
    }

    if (style.markers?.length) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.textBaseline = "middle";
      const points = style.markers.flatMap((m) => ks.map((k) => {
        const [cx, cy] = m.at ?? map.states[m.state].center;
        const x = cx * this.scale + this.ox + k * W * this.scale, y = cy * this.scale + this.oy;
        return { m, x, y, r: (m.kind === "important" ? 3.5 : 5) * this.dpr };
      })).filter(({ x, y }) => x >= 0 && y >= 0 && x <= this.canvas.width && y <= this.canvas.height);
      // Draw every point, even when its label cannot fit at world zoom.
      for (const { m, x, y, r } of points) {
        ctx.beginPath();
        if (m.kind === "important") {
          ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
        } else ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = m.color;
        ctx.fill();
        ctx.lineWidth = 2 * this.dpr;
        ctx.strokeStyle = m.ring ?? "#000";
        ctx.stroke();
      }
      const occupied: number[][] = points.map(({ x, y, r }) => [x - r, y - r, x + r, y + r]);
      for (const { m, x, y, r } of style.showLabels === false ? [] : points) {
        const fontPx = (m.kind === "important" ? 11 : 12) * this.dpr;
        ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
        const width = ctx.measureText(m.label).width, gap = 4 * this.dpr;
        const right = [x + r + gap, y], left = [x - r - gap - width, y];
        const below = [x - width / 2, y + r + fontPx], above = [x - width / 2, y - r - fontPx];
        const candidates = m.labelBelow ? [below, right, left, above] : [right, left, below, above];
        candidates.push([right[0], above[1]], [left[0], above[1]], [right[0], below[1]], [left[0], below[1]]);
        const fits = ([lx, ly]: number[]) => {
          const b = [lx - gap / 2, ly - fontPx / 2 - 2, lx + width + gap / 2, ly + fontPx / 2 + 2];
          if (b[0] < 0 || b[1] < 0 || b[2] > this.canvas.width || b[3] > this.canvas.height) return false;
          return !occupied.some((a) => b[0] < a[2] && b[2] > a[0] && b[1] < a[3] && b[3] > a[1]);
        };
        const label = candidates.find(fits);
        if (!label) continue;
        const [lx, ly] = label;
        occupied.push([lx - gap / 2, ly - fontPx / 2 - 2, lx + width + gap / 2, ly + fontPx / 2 + 2]);
        if (ly !== y) {
          ctx.beginPath(); ctx.moveTo(x, y);
          ctx.lineTo(Math.max(lx, Math.min(x, lx + width)), ly);
          ctx.strokeStyle = "rgba(255,255,255,0.45)"; ctx.lineWidth = this.dpr; ctx.stroke();
        }
        ctx.lineWidth = 3 * this.dpr;
        ctx.strokeStyle = "rgba(0,0,0,0.75)";
        ctx.strokeText(m.label, lx, ly);
        ctx.fillStyle = "#fff";
        ctx.fillText(m.label, lx, ly);
      }
    }
    // Keep this drawing for zoom/pan gestures (drawQuick).
    if (!this.snap) this.snap = document.createElement("canvas");
    if (this.snap.width !== this.canvas.width || this.snap.height !== this.canvas.height) {
      this.snap.width = this.canvas.width;
      this.snap.height = this.canvas.height;
    }
    const sctx = this.snap.getContext("2d")!;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.drawImage(this.canvas, 0, 0);
    this.snapT = { scale: this.scale, ox: this.ox, oy: this.oy };
    this.lastRenderAt = performance.now();
    this.prebuildLevels();
    this.lastDrawMs = performance.now() - t;
  }
}

/**
 * Largest offscreen copy of the map, in device pixels, drawn once and copied for each copy on screen (zoomed in
 * further, at most two copies are on screen and each is drawn directly).
 */
const MAX_WORLD_PIXELS = 16_000_000;
/** Quiet time after the last wheel/drag event before the map is drawn again in full. */
const GESTURE_SETTLE_MS = 150;
/** During a zoom or drag gesture, the map is drawn in full at most this often (user requirement: about 0.1 s). */
const GESTURE_REFRESH_MS = 100;
