// src/utils/latency.ts
import { logger } from './logger';

export class LatencyTracker {
  private marks: Map<string, number> = new Map();

  mark(name: string): void {
    this.marks.set(name, performance.now());
    logger.debug({ mark: name, ts: this.marks.get(name)!.toFixed(1) }, 'Latency mark');
  }

  elapsed(from: string, to: string): number {
    const start = this.marks.get(from);
    const end = this.marks.get(to);
    if (!start || !end) return -1;
    return Math.round(end - start);
  }

  report(): Record<string, number> {
    const marks = [...this.marks.entries()].sort(([, a], [, b]) => a - b);
    const report: Record<string, number> = {};

    for (let i = 1; i < marks.length; i++) {
      const key = `${marks[i - 1][0]}_to_${marks[i][0]}`;
      report[key] = Math.round(marks[i][1] - marks[i - 1][1]);
    }

    if (marks.length >= 2) {
      report.total = Math.round(marks[marks.length - 1][1] - marks[0][1]);
    }

    logger.info({ latency: report }, 'Pipeline latency breakdown');
    return report;
  }
}
