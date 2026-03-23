// src/memory/session.ts
import Redis from 'ioredis';
import { logger } from '../utils/logger';

const TTL_SECONDS = 7200; // 2 hours

export class SessionMemory {
  private store: Map<string, unknown> = new Map();
  private messages: Array<{ role: string; content: string; ts: number }> = [];
  private redis: Redis | null = null;
  private sessionId: string;

  constructor(sessionId?: string) {
    this.sessionId = sessionId ?? `session:${Date.now()}`;
    try {
      this.redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      });
    } catch {
      logger.warn('Redis unavailable — using in-memory session store');
    }
  }

  set(key: string, value: unknown): void {
    this.store.set(key, value);
    this.persistToRedis().catch(() => {});
  }

  get<T = unknown>(key: string): T | undefined {
    return this.store.get(key) as T;
  }

  getAll(): Record<string, unknown> {
    return Object.fromEntries(this.store);
  }

  addMessage(role: string, content: string): void {
    this.messages.push({ role, content, ts: Date.now() });
  }

  getMessages(): Array<{ role: string; content: string; ts: number }> {
    return this.messages;
  }

  getConversationText(): string {
    return this.messages
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n');
  }

  private async persistToRedis(): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.setex(
        this.sessionId,
        TTL_SECONDS,
        JSON.stringify({ store: Object.fromEntries(this.store), messages: this.messages })
      );
    } catch (err) {
      logger.debug({ err }, 'Redis persist failed');
    }
  }

  async loadFromRedis(): Promise<void> {
    if (!this.redis) return;
    try {
      const raw = await this.redis.get(this.sessionId);
      if (raw) {
        const { store, messages } = JSON.parse(raw);
        this.store = new Map(Object.entries(store));
        this.messages = messages;
      }
    } catch (err) {
      logger.debug({ err }, 'Redis load failed');
    }
  }
}
