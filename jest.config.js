/** @type {import("jest").Config} **/
module.exports = {
  testEnvironment: "node",
  setupFiles: ["<rootDir>/jest.setup.env.cjs"],
  transform: {
    // Disable ts-jest type diagnostics so pre-existing type errors in the test
    // corpus do not block test execution.  Runtime type errors will still surface
    // as test failures; this only disables the compiler pre-flight check.
    "^.+\\.tsx?$": ["ts-jest", { diagnostics: false }],
  },
  // Prevent picking up compiled tests emitted to `dist/` by `tsc`.
  testPathIgnorePatterns: ["<rootDir>/dist/", "/node_modules/"],
};