// In-process event broker for browser SSE.
//
// The service publishes only AFTER the database transaction commits; the
// broker stamps monotonic ids and delivery is deferred to a microtask so
// publishers never block. Each subscriber owns a bounded queue: an overflow
// (slow consumer) or a delivery error disconnects that subscriber.
import type { Clock } from "../domain/types";
import { systemClock } from "../domain/types";

export type WorkboardEventType =
  | "item.created"
  | "item.updated"
  | "item.deleted"
  | "comment.created"
  | "participant.created"
  | "label.created";

export interface WorkboardEvent {
  readonly id: string;
  readonly type: WorkboardEventType;
  readonly itemId: number | null;
  readonly occurredAt: string;
}

export interface EventPublisher {
  publish(type: WorkboardEventType, itemId?: number | null): void;
}

export type EventSubscriber = (event: WorkboardEvent) => void;

export interface SubscribeOptions {
  readonly maxQueueSize?: number;
}

export const DEFAULT_MAX_QUEUE_SIZE = 64;

interface Subscription {
  readonly id: number;
  readonly deliver: EventSubscriber;
  readonly onDisconnect: (() => void) | undefined;
  readonly maxQueueSize: number;
  readonly queue: WorkboardEvent[];
  draining: boolean;
  dropped: boolean;
}

export class WorkboardEventBroker implements EventPublisher {
  private readonly clock: Clock;
  private readonly subscriptions = new Map<number, Subscription>();
  private nextEventId = 0;
  private nextSubscriptionId = 0;
  private closed = false;

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  publish(type: WorkboardEventType, itemId: number | null = null): void {
    if (this.closed) return;
    const event: WorkboardEvent = {
      id: String(++this.nextEventId),
      type,
      itemId,
      occurredAt: this.clock.now(),
    };
    for (const subscription of [...this.subscriptions.values()]) {
      subscription.queue.push(event);
      if (subscription.queue.length > subscription.maxQueueSize) {
        // Slow consumer: disconnect it rather than buffering without bound.
        this.drop(subscription, true);
        continue;
      }
      this.scheduleDrain(subscription);
    }
  }

  subscribe(deliver: EventSubscriber, onDisconnect?: () => void, options: SubscribeOptions = {}): () => void {
    const subscription: Subscription = {
      id: ++this.nextSubscriptionId,
      deliver,
      onDisconnect,
      maxQueueSize: options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
      queue: [],
      draining: false,
      dropped: false,
    };
    this.subscriptions.set(subscription.id, subscription);
    return () => {
      if (this.subscriptions.delete(subscription.id)) {
        subscription.dropped = true;
        subscription.queue.length = 0;
      }
    };
  }

  subscriberCount(): number {
    return this.subscriptions.size;
  }

  /** Stops all deliveries and disconnects every subscriber. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const subscription of [...this.subscriptions.values()]) {
      this.drop(subscription, true);
    }
  }

  private scheduleDrain(subscription: Subscription): void {
    if (subscription.draining || subscription.dropped) return;
    subscription.draining = true;
    queueMicrotask(() => {
      subscription.draining = false;
      this.drain(subscription);
    });
  }

  private drain(subscription: Subscription): void {
    while (!subscription.dropped) {
      const event = subscription.queue.shift();
      if (event === undefined) break;
      try {
        subscription.deliver(event);
      } catch {
        this.drop(subscription, true);
        return;
      }
    }
  }

  private drop(subscription: Subscription, notify: boolean): void {
    this.subscriptions.delete(subscription.id);
    subscription.dropped = true;
    subscription.queue.length = 0;
    if (notify) {
      try {
        subscription.onDisconnect?.();
      } catch {
        // A failing disconnect handler must not affect the broker.
      }
    }
  }
}
