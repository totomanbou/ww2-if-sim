import { parseDate, tickTime } from "./date";
import type { SimState } from "./types";

/** Indices of the scenario's landing restrictions in force now (their region is held by the restricting faction). */
function activeRestrictions(sim: SimState): number[] {
  const out: number[] = [];
  sim.restrictions.forEach((r, i) => {
    for (const s of r.region) if (sim.faction[sim.owner[s]] === r.heldBy) { out.push(i); break; }
  });
  return out;
}

/** Per state: 1 if sea-only attacks on it are currently blocked by a landing restriction (scenario). */
export function blockedLandings(sim: SimState): Uint8Array | null {
  const active = activeRestrictions(sim);
  return active.length ? cached(sim, `r${active}`, () => {
    const out = new Uint8Array(sim.nStates);
    for (const i of active) {
      const { protects } = sim.restrictions[i];
      for (let s = 0; s < sim.nStates; s++) if (protects[s]) out[s] = 1;
    }
    return out;
  }) : null;
}

/**
 * The masks only change when a ban expires or a restriction switches on or off, so they are cached per simulation by
 * the set in force (performance: they were rebuilt for every country several times per step). Callers only read them.
 */
const maskCache = new WeakMap<SimState, Map<string, unknown>>();
function cached<T>(sim: SimState, key: string, make: () => T): T {
  let byKey = maskCache.get(sim);
  if (!byKey) maskCache.set(sim, (byKey = new Map()));
  if (!byKey.has(key)) byKey.set(key, make());
  return byKey.get(key) as T;
}

/** States inside the boxes of config.landingBans[i] (cached per simulation and ban). */
const banMaskCache = new WeakMap<SimState, Map<number, Uint8Array>>();
function landingBanMask(sim: SimState, i: number): Uint8Array {
  let byBan = banMaskCache.get(sim);
  if (!byBan) banMaskCache.set(sim, (byBan = new Map()));
  let m = byBan.get(i);
  if (!m) {
    const { boxes, exceptLand = [] } = sim.config.landingBans[i];
    const skip = new Set(exceptLand.map((t) => sim.tags.indexOf(t)));
    m = Uint8Array.from({ length: sim.nStates }, (_, s) => {
      if (skip.has(sim.origOwner[s])) return 0;
      const lon = sim.stateLonLat[2 * s], lat = sim.stateLonLat[2 * s + 1];
      return boxes.some(([w, so, e, n]) => lon >= w && lon <= e && lat >= so && lat <= n) ? 1 : 0;
    });
    byBan.set(i, m);
  }
  return m;
}

/** Per attacker: states it may not land on now because of the date-limited bans (config.landingBans); null = none. */
export function activeLandingBans(sim: SimState): (Uint8Array | null)[] {
  const now = tickTime(sim.startMs, sim.tick, sim.config.stepDays);
  const active = sim.config.landingBans.flatMap((ban, i) => (now < parseDate(ban.until) ? [i] : []));
  return cached(sim, `b${active}`, () => {
    // Countries with the same bans share one mask.
    const byBans = new Map<string, Uint8Array>();
    return sim.tags.map((tag, c) => {
      const mine = active.filter((i) => {
        const ban = sim.config.landingBans[i];
        return sim.faction[c] === ban.faction && !ban.except.includes(tag);
      });
      if (!mine.length) return null;
      const key = String(mine);
      let m = byBans.get(key);
      if (!m) {
        m = new Uint8Array(sim.nStates);
        for (const i of mine) {
          const mask = landingBanMask(sim, i);
          for (let s = 0; s < sim.nStates; s++) if (mask[s]) m[s] = 1;
        }
        byBans.set(key, m);
      }
      return m;
    });
  });
}

/**
 * Per attacker: states it cannot land on now, by the date-limited bans or the scenario's landing restrictions
 * (both are "landing bans" for the fleet placement and the army allocation); null = none.
 */
export function closedLandings(sim: SimState): (Uint8Array | null)[] {
  const banned = activeLandingBans(sim);
  const blocked = blockedLandings(sim);
  if (!blocked) return banned;
  return cached(sim, `c${banned.length}:${activeRestrictions(sim)}|${banKey(sim)}`, () => {
    const byMask = new Map<Uint8Array | null, Uint8Array>();
    return banned.map((m) => {
      let out = byMask.get(m);
      if (!out) {
        out = m ? m.slice() : new Uint8Array(sim.nStates);
        for (let s = 0; s < sim.nStates; s++) if (blocked[s]) out[s] = 1;
        byMask.set(m, out);
      }
      return out;
    });
  });
}

function banKey(sim: SimState): string {
  const now = tickTime(sim.startMs, sim.tick, sim.config.stepDays);
  return String(sim.config.landingBans.flatMap((ban, i) => (now < parseDate(ban.until) ? [i] : [])));
}
