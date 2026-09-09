// A narrow no-undef pass over the overlay scripts.
//
// The overlays are plain .js, so tsc never sees them -- an undefined identifier
// there is a runtime ReferenceError, and the overlays are full of catch blocks
// that would swallow it. That is exactly how the player-detail row click came
// to be broken.
export default [
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        window: "readonly",
        document: "readonly",
        getComputedStyle: "readonly",
        console: "readonly",
        navigator: "readonly",
        localStorage: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        ResizeObserver: "readonly",
        Image: "readonly",
        fetch: "readonly",
        performance: "readonly",
        CustomEvent: "readonly",
        Event: "readonly",
        URL: "readonly",
      },
    },
    rules: { "no-undef": "error" },
  },
];
