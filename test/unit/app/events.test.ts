import { describe, expect, test } from "bun:test";
import { WorkboardEventBroker } from "../../../src/app/events";
import type { WorkboardEvent } from "../../../src/app/events";

const fixedClock = { now: () => "2026-01-01T00:00:00.000Z" };

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("WorkboardEventBroker", () => {
  test("delivers events with monotonic ids and the event shape", async () => {
    const broker = new WorkboardEventBroker(fixedClock);
    const received: WorkboardEvent[] = [];
    broker.subscribe((event) => received.push(event));

    broker.publish("item.created", 7);
    broker.publish("comment.created", 7);
    await flushMicrotasks();

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ id: "1", type: "item.created", itemId: 7, occurredAt: "2026-01-01T00:00:00.000Z" });
    expect(received[1]?.id).toBe("2");
  });

  test("unsubscribe stops delivery and is idempotent", async () => {
    const broker = new WorkboardEventBroker(fixedClock);
    const received: WorkboardEvent[] = [];
    const unsubscribe = broker.subscribe((event) => received.push(event));

    broker.publish("item.created", 1);
    await flushMicrotasks();
    expect(received).toHaveLength(1);
    expect(broker.subscriberCount()).toBe(1);

    expect(unsubscribe()).toBeUndefined();
    unsubscribe(); // idempotent
    expect(broker.subscriberCount()).toBe(0);

    broker.publish("item.updated", 1);
    await flushMicrotasks();
    expect(received).toHaveLength(1);
  });

  test("bounded queue disconnects a slow consumer", async () => {
    const broker = new WorkboardEventBroker(fixedClock);
    const received: WorkboardEvent[] = [];
    let disconnects = 0;
    broker.subscribe(
      (event) => received.push(event),
      () => {
        disconnects += 1;
      },
      { maxQueueSize: 2 },
    );

    // Six synchronous publishes overflow the queue before any microtask runs.
    for (let i = 1; i <= 6; i += 1) broker.publish("item.updated", i);
    await flushMicrotasks();

    expect(disconnects).toBe(1);
    expect(broker.subscriberCount()).toBe(0);
    expect(received.length).toBeLessThanOrEqual(2);
  });

  test("a delivery error disconnects the subscriber without breaking others", async () => {
    const broker = new WorkboardEventBroker(fixedClock);
    const healthy: string[] = [];
    let disconnects = 0;
    broker.subscribe(() => {
      throw new Error("consumer broke");
    });
    broker.subscribe(
      (event) => healthy.push(event.type),
      () => {
        disconnects += 1;
      },
    );

    broker.publish("item.created", 1);
    await flushMicrotasks();

    expect(healthy).toEqual(["item.created"]);
    expect(broker.subscriberCount()).toBe(1);
    expect(disconnects).toBe(0);
  });

  test("close disconnects everyone and ignores later publishes", async () => {
    const broker = new WorkboardEventBroker(fixedClock);
    const received: WorkboardEvent[] = [];
    let disconnects = 0;
    broker.subscribe(
      (event) => received.push(event),
      () => {
        disconnects += 1;
      },
    );

    broker.close();
    broker.close(); // idempotent
    broker.publish("item.created", 1);
    await flushMicrotasks();

    expect(received).toHaveLength(0);
    expect(disconnects).toBe(1);
    expect(broker.subscriberCount()).toBe(0);
  });
});
