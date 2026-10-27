/** Token bucket holding at most `capacity` tokens, refilled continuously at `perSecond`. */
export class TokenBucket {
  private readonly capacity: number;
  private readonly perMs: number;
  private tokens: number;
  private updatedAt: number;

  constructor(capacity: number, perSecond: number, now: number) {
    this.capacity = capacity;
    this.perMs = perSecond / 1000;
    this.tokens = capacity;
    this.updatedAt = now;
  }

  take(amount: number, now: number): boolean {
    this.refill(now);
    if (this.tokens < amount) return false;
    this.tokens -= amount;
    return true;
  }

  isFull(now: number): boolean {
    this.refill(now);
    return this.tokens >= this.capacity;
  }

  private refill(now: number): void {
    this.tokens = Math.min(this.capacity, this.tokens + Math.max(0, now - this.updatedAt) * this.perMs);
    this.updatedAt = now;
  }
}
