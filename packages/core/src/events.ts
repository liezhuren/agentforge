import type { ForgeEvent } from './types.ts';

export type EventListener = (event: ForgeEvent) => void;

/**
 * 领域事件总线。
 *
 * 编排器只向外广播不可变事实，前端（P4）与测试只是投影（projection）。
 * 好处：前端重连不丢状态；结合 runs/ 可离线回放整个项目。
 * 事件是同步派发的，保证测试中的因果顺序确定。
 */
export class EventBus {
  private listeners = new Set<EventListener>();
  private history: ForgeEvent[] = [];
  private record: boolean;

  constructor(opts: { record?: boolean } = {}) {
    this.record = opts.record ?? true;
  }

  on(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ForgeEvent): void {
    if (this.record) this.history.push(event);
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch (err) {
        // 单个订阅者出错不得中断编排主流程
        console.error('[event-bus] listener failed:', err);
      }
    }
  }

  events(): readonly ForgeEvent[] {
    return this.history;
  }

  ofType<T extends ForgeEvent['t']>(t: T): Array<Extract<ForgeEvent, { t: T }>> {
    return this.history.filter((e) => e.t === t) as Array<Extract<ForgeEvent, { t: T }>>;
  }

  clear(): void {
    this.history = [];
  }
}
