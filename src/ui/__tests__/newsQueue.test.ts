import { describe, expect, it } from "vitest";
import { NewsQueue } from "../newsQueue";

const fall = { date: "1940-06-21", text: "フランス共和国がドイツ国に降伏" };
const war = { date: "1940-06-21", text: "自由フランスがドイツ国に宣戦布告" };
const city = { date: "1940-06-21", text: "ダンケルクが陥落" };

describe("news queue", () => {
  it("shows France's surrender for 0.1 seconds before the following declaration, even in the same frame", () => {
    const queue = new NewsQueue();
    for (const item of [fall, war, city]) queue.add(item, 1000);
    expect(queue.current).toEqual(fall);
    expect(queue.pending).toBe(2);
    expect(queue.update(1099)).toBe(false);
    expect(queue.current).toEqual(fall);
    expect(queue.update(1100)).toBe(true);
    expect(queue.current).toEqual(war);
    expect(queue.update(1199)).toBe(false);
    expect(queue.update(1200)).toBe(true);
    expect(queue.current).toEqual(city);
    expect(queue.items).toEqual([fall, war, city]);
  });

  it("does not skip unread news after a large frame gap or highest-speed batch", () => {
    const queue = new NewsQueue();
    for (const item of [fall, war, city]) queue.add(item, 0);
    queue.update(100_000);
    expect(queue.current).toEqual(war);
    expect(queue.update(100_000)).toBe(false);
    expect(queue.pending).toBe(1);
    queue.update(100_100);
    expect(queue.current).toEqual(city);
  });

  it("allows manual advancement and preserves all history", () => {
    const queue = new NewsQueue();
    queue.add(fall, 0); queue.add(war, 0);
    expect(queue.next(1)).toBe(true);
    expect(queue.current).toEqual(war);
    expect(queue.next(2)).toBe(false);
    expect(queue.items).toEqual([fall, war]);
  });

  it("queues closing news after the last city's fall and stops at the closing item", () => {
    const queue = new NewsQueue();
    const end = { date: "1945-08-15", text: "第二次世界大戦終結" };
    queue.add(city, 0); queue.add(end, 0);
    expect(queue.current).toEqual(city);
    queue.update(100);
    expect(queue.current).toEqual(end);
    expect(queue.update(200)).toBe(false);
    expect(queue.pending).toBe(0);
  });
});
