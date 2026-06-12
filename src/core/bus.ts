import type { BusTopics } from './contracts';

// The only crossing point between modules. The conductor publishes; audio and
// visuals subscribe; interaction publishes control only.

type Handler<T> = (payload: T) => void;

export type Topic = keyof BusTopics;

export class Bus {
  private readonly handlers = new Map<Topic, Set<Handler<never>>>();

  subscribe<K extends Topic>(topic: K, handler: Handler<BusTopics[K]>): () => void {
    let set = this.handlers.get(topic);
    if (!set) {
      set = new Set();
      this.handlers.set(topic, set);
    }
    set.add(handler as Handler<never>);
    return () => {
      set.delete(handler as Handler<never>);
    };
  }

  publish<K extends Topic>(topic: K, payload: BusTopics[K]): void {
    const set = this.handlers.get(topic);
    if (!set) return;
    for (const handler of set) {
      (handler as Handler<BusTopics[K]>)(payload);
    }
  }
}

/** One shared bus per session. */
export const bus = new Bus();
