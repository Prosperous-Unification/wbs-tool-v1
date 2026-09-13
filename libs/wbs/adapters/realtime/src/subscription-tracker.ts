export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'wbs:realtime:last-seq';

export class SubscriptionTracker {
  private readonly state: Record<string, number>;
  constructor(private readonly storage: KeyValueStorage) {
    const raw = storage.getItem(STORAGE_KEY);
    this.state = raw ? (JSON.parse(raw) as Record<string, number>) : {};
  }

  update(subscription: string, seq: number): void {
    const current = this.state[subscription] ?? -1;
    if (seq > current) {
      this.state[subscription] = seq;
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    }
  }

  snapshot(): Record<string, number> {
    return { ...this.state };
  }
}
