# Phase 2 artifacts — A2A v0.3 → v1.0 wire-format port

This directory captures the test state **before** the port (commit `36137ce`).
Phase 3 will be the port itself; the matching green artifacts will land in
`phase3_artifacts/` on the same branch.

## Files

- `phase2_baseline.txt` — pre-test-insertion baseline:
  513 passing, 0 failing, 5 cancelled (P0/integration suites that need
  a live OpenClaw gateway)
- `phase2_red_state.txt` — post-insertion state:
  513 passing, 1 failing (the new file), 5 cancelled
- `phase2_wire_v1_red.tap` — TAP output from running just
  `tests/wire-v1.0.test.ts` in RED state. Exit code 1; failure is
  `SyntaxError: The requested module '@a2a-js/sdk' does not provide
  an export named 'ClientFactory'` — proves the v0.3 SDK does not
  export the v1.0 contract symbols the test uses.
- `phase2_full_suite_red.tap` — TAP output of running every test file
  in the suite (27 files) in RED state. 1 `not ok` (the new file),
  0 collateral damage.

## What "RED" means here

The v1.0 wire-format contract test fails **at import time** because
the fork is pinned to `@a2a-js/sdk ^0.3.13`. v1.0 symbols
(`ClientFactory`, `DefaultRequestHandler`, `InMemoryTaskStore`,
`jsonRpcHandler`, `agentCardHandler`, `UserBuilder`) are not
exported by the v0.3 line's top-level entry.

Phase 3 bumps the SDK to `^1.0.1` and rewires the server routes to
use the v1.0 SDK's Express middleware. The contract test is
expected to go green; the 5 cancelled P0 tests will stay cancelled
(needing a live gateway). Some of the 513 v0.3 tests may start
failing on fixture mismatches; phase 3 handles those by either
fixing the fixtures or `.skip`-with-explanation per the port plan.
