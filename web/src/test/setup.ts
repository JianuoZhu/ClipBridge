import "@testing-library/jest-dom/vitest";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => {
    let matches = false;
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    return {
      media: query, get matches() { return matches; }, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
      dispatchEvent: () => true
    };
  }
});

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
class IntersectionObserverMock {
  constructor(private callback: IntersectionObserverCallback) {}
  observe(target: Element) { this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
  unobserve() {}
  disconnect() {}
  root = null; rootMargin = ""; thresholds = [];
  takeRecords() { return []; }
}
Object.defineProperty(window, "ResizeObserver", { value: ResizeObserverMock });
Object.defineProperty(window, "IntersectionObserver", { value: IntersectionObserverMock });
Object.defineProperty(globalThis, "ResizeObserver", { value: ResizeObserverMock });
Object.defineProperty(globalThis, "IntersectionObserver", { value: IntersectionObserverMock });
Object.defineProperty(URL, "createObjectURL", { value: () => "blob:test" });
Object.defineProperty(URL, "revokeObjectURL", { value: () => {} });
