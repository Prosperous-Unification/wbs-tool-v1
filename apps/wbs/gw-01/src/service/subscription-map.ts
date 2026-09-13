export class SubscriptionMap<Socket> {
  private readonly map = new Map<string, Set<Socket>>();

  subscribe(subscription: string, socket: Socket): void {
    let set = this.map.get(subscription);
    if (!set) {
      set = new Set();
      this.map.set(subscription, set);
    }
    set.add(socket);
  }

  unsubscribe(subscription: string, socket: Socket): void {
    const set = this.map.get(subscription);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.map.delete(subscription);
  }

  socketsFor(subscription: string): Set<Socket> {
    return this.map.get(subscription) ?? new Set();
  }

  removeAll(socket: Socket): void {
    for (const [k, set] of this.map) {
      set.delete(socket);
      if (set.size === 0) this.map.delete(k);
    }
  }

  activeCount(): number {
    let total = 0;
    for (const set of this.map.values()) total += set.size;
    return total;
  }
}
