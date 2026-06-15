import '@testing-library/jest-dom/vitest';

// jsdom doesn't ship EventSource. Components that open one in
// useEffect (Versions.tsx, future SSE consumers) would otherwise
// throw on first render. Provide a no-op constructor wide enough to
// satisfy the property accesses we make. Open instances are tracked in
// `StubEventSource.instances` so a test can reach the live EventSource and
// drive `onmessage` to simulate a server-sent progress event.
class StubEventSource {
  static instances: StubEventSource[] = [];
  readonly url: string;
  readonly readyState = 0;
  onmessage: ((ev: MessageEvent<string>) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    StubEventSource.instances.push(this);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
  /** Test helper: deliver a JSON payload as if the server pushed it. */
  emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
}

if (typeof globalThis.EventSource === 'undefined') {
  // The DOM lib's EventSource shape is wider than what tests touch.
  // Cast through `unknown` rather than feigning the full interface.
  (globalThis as unknown as { EventSource: typeof StubEventSource }).EventSource = StubEventSource;
}

// Exposed for tests that need to push SSE events (see Versions progress
// filtering). Reset between tests is the test's responsibility.
export { StubEventSource };
