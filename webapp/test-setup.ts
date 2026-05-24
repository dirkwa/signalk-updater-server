import '@testing-library/jest-dom/vitest';

// jsdom doesn't ship EventSource. Components that open one in
// useEffect (Versions.tsx, future SSE consumers) would otherwise
// throw on first render. Provide a no-op constructor wide enough to
// satisfy the property accesses we make.
class StubEventSource {
  readonly url: string;
  readonly readyState = 0;
  onmessage: ((ev: MessageEvent<string>) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

if (typeof globalThis.EventSource === 'undefined') {
  // The DOM lib's EventSource shape is wider than what tests touch.
  // Cast through `unknown` rather than feigning the full interface.
  (globalThis as unknown as { EventSource: typeof StubEventSource }).EventSource = StubEventSource;
}
