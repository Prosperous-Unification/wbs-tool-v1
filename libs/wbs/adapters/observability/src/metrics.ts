import { type Counter as OtelCounter, metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('@wbs/observability', '1.0.0');

export class Counter {
  private readonly impl: OtelCounter;
  constructor(name: string, description?: string) {
    this.impl = meter.createCounter(name, { description });
  }
  inc(value = 1, attrs?: Record<string, string>): void {
    this.impl.add(value, attrs);
  }
}

export class Histogram {
  private readonly impl;
  constructor(
    private readonly name: string,
    private readonly description?: string,
  ) {
    this.impl = meter.createHistogram(this.name, { description: this.description });
  }
  observe(value: number, attrs?: Record<string, string>): void {
    this.impl.record(value, attrs);
  }
}

export class Gauge {
  private readonly impl;
  constructor(
    private readonly name: string,
    private readonly description?: string,
  ) {
    this.impl = meter.createUpDownCounter(this.name, { description: this.description });
  }
  set(value: number, attrs?: Record<string, string>): void {
    this.impl.add(value, attrs);
  }
}
