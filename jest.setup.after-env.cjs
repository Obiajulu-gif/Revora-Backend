const fs = require('fs');

const originalEnv = { ...process.env };
const originalFs = {
  readFileSync: fs.readFileSync,
  statSync: fs.statSync,
  readdirSync: fs.readdirSync,
};

afterEach(() => {
  // Restore Node fs functions in case any test monkey-patched them directly.
  fs.readFileSync = originalFs.readFileSync;
  fs.statSync = originalFs.statSync;
  fs.readdirSync = originalFs.readdirSync;

  // Restore environment variables to a known baseline across test files.
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    process.env[key] = value;
  }

  // Ensure no undefined env entries leak into ts-jest cache key calculation.
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) {
      delete process.env[key];
    }
  }

  jest.restoreAllMocks();
});
