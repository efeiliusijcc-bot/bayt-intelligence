import "@testing-library/jest-dom/vitest";

if (typeof globalThis.NodeFilter === "undefined" && typeof window !== "undefined") {
  Object.defineProperty(globalThis, "NodeFilter", { value: window.NodeFilter });
}
