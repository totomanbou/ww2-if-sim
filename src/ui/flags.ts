/**
 * Small, simplified flag icons (as of 1939) for every country tag of the historical preset.
 * Pure SVG string templates in a 30x20 viewBox: stripes, crosses, cantons, discs and stars only, so they stay
 * recognisable at 12-16 px. No coats of arms, no text. Germany uses the Reich national colours (black-white-red).
 */

const W = 30;
const H = 20;

type Weights = readonly number[];

function rect(x: number, y: number, w: number, h: number, fill: string): string {
  return `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" fill="${fill}"/>`;
}

function r(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function disc(cx: number, cy: number, rad: number, fill: string, stroke?: string): string {
  const s = stroke ? ` stroke="${stroke}" stroke-width=".4"` : "";
  return `<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(rad)}" fill="${fill}"${s}/>`;
}

function poly(points: readonly (readonly [number, number])[], fill: string, stroke?: string): string {
  const s = stroke ? ` stroke="${stroke}" stroke-width="1" stroke-linejoin="round"` : "";
  return `<polygon points="${points.map(([x, y]) => `${r(x)},${r(y)}`).join(" ")}" fill="${fill}"${s}/>`;
}

function star(cx: number, cy: number, rad: number, fill: string): string {
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const a = (Math.PI * i) / 5 - Math.PI / 2;
    const rr = i % 2 === 0 ? rad : rad * 0.382;
    pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
  }
  return poly(pts, fill);
}

/** Horizontal stripes (top to bottom) over the box (x, y, w, h), sized by `weights` (equal when omitted). */
function hs(colors: readonly string[], weights?: Weights, x = 0, y = 0, w = W, h = H): string {
  const ws = weights ?? colors.map(() => 1);
  const total = ws.reduce((a, b) => a + b, 0);
  let cur = y;
  return colors
    .map((c, i) => {
      const sh = (h * ws[i]) / total;
      const out = rect(x, cur, w, sh + (i < colors.length - 1 ? 0.02 : 0), c);
      cur += sh;
      return out;
    })
    .join("");
}

/** Vertical stripes (left to right) over the box (x, y, w, h). */
function vs(colors: readonly string[], weights?: Weights, x = 0, y = 0, w = W, h = H): string {
  const ws = weights ?? colors.map(() => 1);
  const total = ws.reduce((a, b) => a + b, 0);
  let cur = x;
  return colors
    .map((c, i) => {
      const sw = (w * ws[i]) / total;
      const out = rect(cur, y, sw + (i < colors.length - 1 ? 0.02 : 0), h, c);
      cur += sw;
      return out;
    })
    .join("");
}

/** A cross with vertical bar centred at x = cx and horizontal bar centred at y = cy, bars of thickness t. */
function cross(cx: number, cy: number, t: number, fill: string, x0 = 0, y0 = 0, x1 = W, y1 = H): string {
  return rect(cx - t / 2, y0, t, y1 - y0, fill) + rect(x0, cy - t / 2, x1 - x0, t, fill);
}

/** Simplified Union Jack placed into the box (x, y, w, h). */
function jack(x = 0, y = 0, w = W, h = H): string {
  const body =
    rect(0, 0, W, H, "#012169") +
    `<line x1="0" y1="0" x2="${W}" y2="${H}" stroke="#ffffff" stroke-width="4"/>` +
    `<line x1="${W}" y1="0" x2="0" y2="${H}" stroke="#ffffff" stroke-width="4"/>` +
    `<line x1="0" y1="0" x2="${W}" y2="${H}" stroke="#c8102e" stroke-width="1.6"/>` +
    `<line x1="${W}" y1="0" x2="0" y2="${H}" stroke="#c8102e" stroke-width="1.6"/>` +
    cross(15, 10, 6, "#ffffff") +
    cross(15, 10, 3.6, "#c8102e");
  return `<svg x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${body}</svg>`;
}

const WHITE = "#ffffff";
const BLACK = "#000000";
const RED = "#c8102e";
const YELLOW = "#ffd100";

/** Dots arranged as a rough star field, used for stars that would be too small to draw as polygons. */
function dots(points: readonly (readonly [number, number])[], rad: number, fill: string): string {
  return points.map(([x, y]) => disc(x, y, rad, fill)).join("");
}

function usa(): string {
  const stripeH = H / 13;
  let s = "";
  for (let i = 0; i < 13; i++) s += rect(0, i * stripeH, W, stripeH + 0.02, i % 2 === 0 ? "#b22234" : WHITE);
  s += rect(0, 0, 12, 7 * stripeH, "#3c3b6e");
  const pts: [number, number][] = [];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 4; col++) pts.push([2 + col * 2.7, 2.1 + row * 2.9]);
  return s + dots(pts, 0.65, WHITE);
}

function hasStripes(count: number, first: string, second: string, x: number, y: number, w: number, h: number): string {
  const colors: string[] = [];
  for (let i = 0; i < count; i++) colors.push(i % 2 === 0 ? first : second);
  return hs(colors, undefined, x, y, w, h);
}

const FLAGS: Readonly<Record<string, () => string>> = {
  USA: usa,
  // Reich national colours; deliberately no emblem of any kind.
  GER: () => hs([BLACK, WHITE, "#dd0000"]),
  SOV: () => rect(0, 0, W, H, "#cc0000") + star(5.5, 5.5, 3.6, YELLOW),
  UK: () => jack(),
  FRA: () => vs(["#002395", WHITE, "#ed2939"]),
  FFR: () => {
    const lorraine =
      rect(14.2, 3, 1.6, 14, "#ed2939") + rect(12.2, 6, 5.6, 1.5, "#ed2939") + rect(11.4, 10.2, 7.2, 1.5, "#ed2939");
    return vs(["#002395", WHITE, "#ed2939"]) + lorraine;
  },
  JAP: () => rect(0, 0, W, H, WHITE) + disc(15, 10, 6, "#bc002d"),
  ITA: () => vs(["#009246", WHITE, "#ce2b37"]),
  CHN: () => rect(0, 0, W, H, "#de2910") + rect(0, 0, 15, 10, "#1d3a8a") + disc(7.5, 5, 3.4, WHITE),
  POL: () => hs([WHITE, "#dc143c"]),
  CAN: () =>
    rect(0, 0, W, H, "#cc0000") + jack(0, 0, 15, 10) + disc(22.5, 10.5, 3.2, WHITE) + disc(22.5, 10.5, 1.4, "#cc0000"),
  // British India: the red ensign with the Star of India badge (simplified as a gold star disc on blue).
  IND: () =>
    rect(0, 0, W, H, "#cc0000") + jack(0, 0, 15, 10) + disc(22.5, 10.5, 3.4, "#1d3a8a") + disc(22.5, 10.5, 1.6, "#f2c94c"),
  AST: () => {
    const southernCross = dots(
      [
        [22, 14.5],
        [25.5, 10],
        [22, 4.5],
        [18.8, 9],
      ],
      1,
      WHITE,
    );
    return rect(0, 0, W, H, "#00008b") + jack(0, 0, 15, 10) + star(7.5, 15.5, 2.8, WHITE) + southernCross;
  },
  NZL: () => {
    const cross4 = [
      [22, 14.5],
      [25.5, 10],
      [22, 4.5],
      [18.8, 9],
    ] as const;
    return (
      rect(0, 0, W, H, "#00247d") +
      jack(0, 0, 15, 10) +
      cross4.map(([x, y]) => disc(x, y, 1.1, "#cc142b", WHITE)).join("")
    );
  },
  // 1928-1994 flag: orange, white, blue with a tiny Union Jack and two small flags in the white band.
  SAF: () =>
    hs(["#e07b00", WHITE, "#00237b"]) +
    jack(11.3, 8, 7.4, 4.9) +
    rect(7.3, 8.5, 2.8, 3.9, "#e07b00") +
    rect(19.9, 8.5, 2.8, 3.9, "#de3831"),
  HOL: () => hs(["#ae1c28", WHITE, "#21468b"]),
  NEI: () => hs(["#ae1c28", WHITE, "#21468b"]),
  BEL: () => vs([BLACK, "#fdda24", "#ef3340"]),
  LUX: () => hs(["#ed2939", WHITE, "#00a1de"]),
  DEN: () => rect(0, 0, W, H, "#c8102e") + cross(11, 10, 3, WHITE),
  NOR: () => rect(0, 0, W, H, "#ba0c2f") + cross(10.5, 10, 5, WHITE) + cross(10.5, 10, 2.4, "#00205b"),
  GRE: () => {
    const s = hasStripes(9, "#0d5eaf", WHITE, 0, 0, W, H);
    const canton = rect(0, 0, 11.1, 11.1, "#0d5eaf") + cross(5.55, 5.55, 2.2, WHITE, 0, 0, 11.1, 11.1);
    return s + canton;
  },
  YUG: () => hs(["#0c4076", WHITE, "#c6363c"]),
  HUN: () => hs(["#ce2939", WHITE, "#477050"]),
  ROM: () => vs(["#002b7f", "#fcd116", "#ce1126"]),
  BUL: () => hs([WHITE, "#00966e", "#d62612"]),
  // Slovak State: white-blue-red with a small red shield (white cross) near the hoist.
  SLO: () =>
    hs([WHITE, "#0b4ea2", "#ee1c25"]) +
    rect(5, 4.5, 7, 9.5, RED) +
    cross(8.5, 8.7, 1.6, WHITE, 5, 4.5, 12, 14),
  FIN: () => rect(0, 0, W, H, WHITE) + cross(10.5, 10, 4, "#003580"),
  SIA: () => hs(["#a51931", WHITE, "#2d2a4a", WHITE, "#a51931"], [1, 1, 2, 1, 1]),
  SWE: () => rect(0, 0, W, H, "#006aa7") + cross(10.5, 10, 4, "#fecc00"),
  SWI: () => rect(0, 0, W, H, "#da291c") + cross(15, 10, 4, WHITE, 8.5, 4, 21.5, 16),
  // 1939 Nationalist flag: red-yellow-red, no emblem.
  SPA: () => hs(["#c60b1e", "#ffc400", "#c60b1e"], [1, 2, 1]),
  POR: () => vs(["#006600", "#da291c"], [2, 3]) + disc(12, 10, 3.6, YELLOW) + disc(12, 10, 1.6, WHITE),
  IRE: () => vs(["#169b62", WHITE, "#ff883e"]),
  TUR: () =>
    rect(0, 0, W, H, "#e30a17") + disc(10.5, 10, 5.3, WHITE) + disc(12, 10, 4.2, "#e30a17") + star(17.5, 10, 2.6, WHITE),
  EST: () => hs(["#0072ce", BLACK, WHITE]),
  LAT: () => hs(["#9e3039", WHITE, "#9e3039"], [2, 1, 2]),
  LIT: () => hs(["#fdb913", "#006a44", "#c1272d"]),
  IRN: () => hs(["#239f40", WHITE, "#da0000"]) + disc(15, 10, 2.3, "#e8b400"),
  AFG: () => vs([BLACK, "#be0000", "#007a36"]) + disc(15, 10, 2.8, WHITE),
  // Green field with a white sword and a line of script approximated by bars.
  SAU: () =>
    rect(0, 0, W, H, "#006c35") +
    rect(7, 5.2, 16, 1.6, WHITE) +
    rect(10, 8.2, 10, 1.3, WHITE) +
    rect(5, 13, 20, 1.2, WHITE) +
    rect(21.5, 11.8, 1.2, 3.6, WHITE),
  // Red with a white sword and five stars.
  YEM: () =>
    rect(0, 0, W, H, "#ce1126") +
    rect(14.3, 3.5, 1.4, 10.5, WHITE) +
    rect(11.5, 12, 7, 1.4, WHITE) +
    dots(
      [
        [7, 8],
        [9, 5],
        [21, 5],
        [23, 8],
        [15, 17],
      ],
      1.2,
      WHITE,
    ),
  // Double-pennant flag: crimson with a blue border, white moon above, sun below.
  NEP: () =>
    poly(
      [
        [4, 1],
        [19, 9.5],
        [12, 9.5],
        [25, 19],
        [4, 19],
      ],
      "#dc143c",
      "#003893",
    ) +
    disc(8, 6, 1.4, WHITE) +
    disc(8, 14.5, 1.8, WHITE),
  // Orange-yellow diagonal with a white dragon approximated by an ellipse.
  BHU: () =>
    poly(
      [
        [0, 0],
        [W, 0],
        [0, H],
      ],
      "#ffd520",
    ) +
    poly(
      [
        [W, 0],
        [W, H],
        [0, H],
      ],
      "#ff4e12",
    ) +
    `<ellipse cx="15" cy="10" rx="9" ry="2.4" fill="${WHITE}" transform="rotate(-33.7 15 10)"/>`,
  // Red field, yellow Soyombo approximated by a disc and a bar near the hoist.
  MON: () =>
    rect(0, 0, W, H, "#da2032") +
    star(7, 5, 2.4, "#ffd900") +
    disc(7, 9.5, 1.5, "#ffd900") +
    rect(5, 12, 4, 1.2, "#ffd900") +
    rect(5, 14.5, 4, 1.2, "#ffd900"),
  // Snow Lion flag: red-and-blue rays over a white mountain with a sun, on a yellow border.
  TIB: () => {
    const rays: string[] = [];
    for (let i = 0; i < 6; i++) rays.push(i % 2 === 0 ? "#1a3d8f" : "#c8102e");
    return (
      rect(0, 0, W, H, "#ffd100") +
      rect(2, 2, 26, 16, "#ffffff") +
      vs(rays, undefined, 2, 2, 26, 8) +
      poly(
        [
          [2, 18],
          [15, 7],
          [28, 18],
        ],
        WHITE,
      ) +
      disc(15, 5.5, 1.8, "#ffd100")
    );
  },
  LBR: () => {
    const stripeH = H / 11;
    let s = "";
    for (let i = 0; i < 11; i++) s += rect(0, i * stripeH, W, stripeH + 0.02, i % 2 === 0 ? "#bf0a30" : WHITE);
    return s + rect(0, 0, 5 * stripeH, 5 * stripeH, "#002868") + star((5 * stripeH) / 2, (5 * stripeH) / 2, 3, WHITE);
  },
  MEX: () => vs(["#006847", WHITE, "#ce1126"]) + disc(15, 10, 2.5, "#8b6b2e"),
  BRA: () =>
    rect(0, 0, W, H, "#009c3b") +
    poly(
      [
        [15, 2],
        [27, 10],
        [15, 18],
        [3, 10],
      ],
      "#ffdf00",
    ) +
    disc(15, 10, 4.6, "#002776"),
  ARG: () => hs(["#74acdf", WHITE, "#74acdf"]) + disc(15, 10, 1.7, "#f6b40e"),
  CHL: () => hs([WHITE, "#d52b1e"]) + rect(0, 0, 10, 10, "#0039a6") + star(5, 5, 3, WHITE),
  COL: () => hs(["#fcd116", "#003893", "#ce1126"], [2, 1, 1]),
  VEN: () =>
    hs(["#ffcc00", "#00247d", "#cf142b"]) +
    dots(
      [
        [9, 11.2],
        [11.5, 9.9],
        [15, 9.4],
        [18.5, 9.9],
        [21, 11.2],
      ],
      0.8,
      WHITE,
    ),
  PER: () => vs(["#d91023", WHITE, "#d91023"]),
  CUB: () =>
    hasStripes(5, "#002a8f", WHITE, 0, 0, W, H) +
    poly(
      [
        [0, 0],
        [13, 10],
        [0, 20],
      ],
      "#cf142b",
    ) +
    star(4.2, 10, 2.8, WHITE),
  URU: () => {
    const s = hasStripes(9, WHITE, "#0038a8", 0, 0, W, H);
    return s + rect(0, 0, 11.1, 11.1, WHITE) + disc(5.55, 5.55, 3, "#fcd116");
  },
  BOL: () => hs(["#d52b1e", "#f9e300", "#007934"]),
  PAR: () => hs(["#d52b1e", WHITE, "#0038a8"]),
  ECU: () => hs(["#ffdd00", "#034ea2", "#ed1c24"], [2, 1, 1]) + disc(15, 10, 2.2, "#8b6b2e"),
  GUA: () => vs(["#4997d0", WHITE, "#4997d0"]) + disc(15, 10, 2.4, "#3f7d20"),
  HON: () =>
    hs(["#0073cf", WHITE, "#0073cf"]) +
    dots(
      [
        [15, 10],
        [11.5, 10],
        [18.5, 10],
        [12.7, 8],
        [17.3, 12],
      ],
      0.9,
      "#0073cf",
    ),
  ELS: () => hs(["#0f47af", WHITE, "#0f47af"]) + disc(15, 10, 2.2, "#c9a227"),
  NIC: () =>
    hs(["#0067c6", WHITE, "#0067c6"]) +
    poly(
      [
        [15, 6.8],
        [18, 12.5],
        [12, 12.5],
      ],
      "#7a8f3a",
    ),
  COS: () => hs(["#002b7f", WHITE, "#ce1126", WHITE, "#002b7f"], [1, 1, 2, 1, 1]),
  PAN: () =>
    rect(0, 0, W, H, WHITE) +
    rect(15, 0, 15, 10, "#d21034") +
    rect(0, 10, 15, 10, "#005293") +
    star(7.5, 5, 3, "#005293") +
    star(22.5, 15, 3, "#d21034"),
  HAI: () => hs(["#00209f", "#d21034"]) + rect(10, 7, 10, 6, WHITE) + disc(15, 10, 1.6, "#2d8a34"),
  DOM: () =>
    rect(0, 0, W, H, "#002d62") +
    rect(15, 0, 15, 10, "#ce1126") +
    rect(0, 10, 15, 10, "#ce1126") +
    cross(15, 10, 3.6, WHITE),
};

/** Inline SVG markup (viewBox "0 0 30 20", width/height attributes given by the caller's size) for a 1939 flag; null if unknown. */
export function flagSvg(tag: string, height = 12): string | null {
  if (!Object.prototype.hasOwnProperty.call(FLAGS, tag)) return null;
  const h = r(height);
  const w = r(height * 1.5);
  const border = `<rect x="0.1" y="0.1" width="29.8" height="19.8" fill="none" stroke="rgba(0,0,0,.35)" stroke-width=".5" vector-effect="non-scaling-stroke"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${w}" height="${h}" aria-hidden="true" focusable="false">${FLAGS[tag]()}${border}</svg>`;
}

/** An HTMLElement (span.flag containing the SVG) for the tag; falls back to a span.flag with background `fallbackColor` when there is no flag. Has title = tag. */
export function flagEl(tag: string, fallbackColor: string, height = 12): HTMLElement {
  const el = document.createElement("span");
  el.className = "flag";
  el.title = tag;
  const svg = flagSvg(tag, height);
  if (svg) {
    el.innerHTML = svg;
  } else {
    el.style.width = `${r(height * 1.5)}px`;
    el.style.height = `${r(height)}px`;
    el.style.background = fallbackColor;
    el.style.boxShadow = "inset 0 0 0 0.5px rgba(0,0,0,.35)";
  }
  return el;
}
