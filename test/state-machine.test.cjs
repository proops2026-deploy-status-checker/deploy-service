const assert = require("node:assert/strict");
const test = require("node:test");
const { canTransition, isEnvironment } = require("../dist/state-machine.js");

test("TIE-20 release-flow state machine — allowed transitions (IRD-001 §6)", () => {
  assert.equal(canTransition("STARTED", "SUCCESS"), true);
  assert.equal(canTransition("STARTED", "FAILED"), true);
  assert.equal(canTransition("SUCCESS", "ROLLED_BACK"), true);
  assert.equal(canTransition("FAILED", "ROLLED_BACK"), true);
});

test("TIE-20 release-flow state machine — disallowed transitions", () => {
  assert.equal(canTransition("STARTED", "ROLLED_BACK"), false);
  assert.equal(canTransition("SUCCESS", "FAILED"), false);
  assert.equal(canTransition("SUCCESS", "STARTED"), false);
  assert.equal(canTransition("FAILED", "SUCCESS"), false);
  assert.equal(canTransition("ROLLED_BACK", "STARTED"), false);
  assert.equal(canTransition("ROLLED_BACK", "SUCCESS"), false);
  assert.equal(canTransition("ROLLED_BACK", "FAILED"), false);
});

test("TIE-20 isEnvironment validates dev/staging/prod only", () => {
  assert.equal(isEnvironment("dev"), true);
  assert.equal(isEnvironment("staging"), true);
  assert.equal(isEnvironment("prod"), true);
  assert.equal(isEnvironment("production"), false);
  assert.equal(isEnvironment(""), false);
  assert.equal(isEnvironment(undefined), false);
  assert.equal(isEnvironment(123), false);
});
