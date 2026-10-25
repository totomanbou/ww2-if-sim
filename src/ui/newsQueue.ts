export interface NewsItem { date: string; text: string }

/** A real-time queue: simulated speed and same-frame events cannot overwrite an unread headline. */
export class NewsQueue {
  readonly items: NewsItem[] = [];
  private index = -1;
  private shownAt = 0;
  constructor(readonly minimumMs = 100) {}

  get current(): NewsItem | undefined { return this.items[this.index]; }
  get pending(): number { return this.items.length - this.index - 1; }

  add(item: NewsItem, now: number): void {
    this.items.push(item);
    if (this.index < 0) { this.index = 0; this.shownAt = now; }
  }

  next(now: number): boolean {
    if (!this.pending) return false;
    this.index++;
    this.shownAt = now;
    return true;
  }

  update(now: number): boolean {
    // Advance at most once even after a sleeping tab resumes.
    return now - this.shownAt >= this.minimumMs && this.next(now);
  }
}
