/**
 * Adds `formerOwner` to the states of an existing data/map.json (see scripts/map/former-owner.ts) without
 * rebuilding the map; build-map.ts does the same for new builds. Usage: tsx scripts/add-former-owner.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { addFormerOwners } from "./map/former-owner";

const mapUrl = new URL("../data/map.json", import.meta.url);
const map = JSON.parse(readFileSync(mapUrl, "utf8"));
const fixes = JSON.parse(readFileSync(new URL("../data/border-fixes.json", import.meta.url), "utf8"));
for (const s of map.states) delete s.formerOwner;
// regionFixes (ownership changed in the build) and formerOwners (marks only, e.g. Manchukuo as Japanese-occupied China).
const n = addFormerOwners(map.states, [...fixes.regionFixes, ...(fixes.formerOwners ?? [])]);
writeFileSync(mapUrl, JSON.stringify(map));
const by = new Map<string, number>();
for (const s of map.states) if (s.formerOwner) by.set(`${s.formerOwner}→${s.owner}`, (by.get(`${s.formerOwner}→${s.owner}`) ?? 0) + 1);
console.log(`formerOwner set on ${n} states:`, Object.fromEntries(by));
