# OpenClaw Plugin Compatibility Report

Generated: deterministic
Status: PASS

## Summary

| Metric                    | Value |
| ------------------------- | ----- |
| Fixtures                  | 1     |
| High-priority fixtures    | 1     |
| Hard breakages            | 0     |
| Warnings                  | 1     |
| Compatibility suggestions | 4     |
| Issue findings            | 5     |
| P0 issues                 | 0     |
| P1 issues                 | 1     |
| Live issues               | 0     |
| Live P0 issues            | 0     |
| Compat gaps               | 0     |
| Deprecation warnings      | 1     |
| Inspector gaps            | 4     |
| Upstream metadata         | 0     |
| Contract probes           | 5     |
| Decision rows             | 5     |

## Triage Overview

| Class               | Count | P0 | Meaning                                                                                                         |
| ------------------- | ----- | -- | --------------------------------------------------------------------------------------------------------------- |
| live-issue          | 0     | 0  | Potential runtime breakage in the target OpenClaw/plugin pair. P0 only when it is not a deprecated compat seam. |
| compat-gap          | 0     | -  | Compatibility behavior is needed but missing from the target OpenClaw compat registry.                          |
| deprecation-warning | 1     | -  | Plugin uses a supported but deprecated compatibility seam; keep it wired while migration exists.                |
| inspector-gap       | 4     | -  | Plugin Inspector needs stronger capture/probe evidence before making contract judgments.                        |
| upstream-metadata   | 0     | -  | Plugin package or manifest metadata should improve upstream; not a target OpenClaw live break by itself.        |
| fixture-regression  | 0     | -  | Fixture no longer exposes an expected seam; investigate fixture pin or scanner drift.                           |

## P0 Live Issues

_none_

## Live Issues

_none_

## Compat Gaps

_none_

## Deprecation Warnings

- P2 **a2a-gateway** `deprecation-warning` `core-compat-adapter`
  - **legacy-root-sdk-import**: a2a-gateway: root plugin SDK barrel is still used by fixtures
  - state: open · compat:deprecated · deprecated
  - evidence:
    - openclaw/plugin-sdk @ src/types.ts:14

## Inspector Proof Gaps

- P1 **a2a-gateway** `inspector-gap` `inspector-follow-up`
  - **registration-capture-gap**: a2a-gateway: runtime registrations need capture before contract judgment
  - state: open · compat:none
  - evidence:
    - registerGatewayMethod @ index.ts:616
    - registerGatewayMethod @ index.ts:622
    - registerGatewayMethod @ index.ts:631
    - registerGatewayMethod @ index.ts:657
    - registerGatewayMethod @ index.ts:669
    - registerService @ index.ts:857

- P2 **a2a-gateway** `inspector-gap` `inspector-follow-up`
  - **package-dependency-install-required**: a2a-gateway: cold import requires isolated dependency installation
  - state: open · compat:none
  - evidence:
    - @a2a-js/sdk @ package.json
    - @bufbuild/protobuf @ package.json
    - @grpc/grpc-js @ package.json
    - express @ package.json
    - multicast-dns @ package.json
    - uuid @ package.json
    - ws @ package.json

- P2 **a2a-gateway** `inspector-gap` `inspector-follow-up`
  - **package-typescript-source-entrypoint**: a2a-gateway: cold import needs TypeScript source entrypoint support
  - state: open · compat:none
  - evidence:
    - extension:index.ts

- P2 **a2a-gateway** `inspector-gap` `inspector-follow-up`
  - **runtime-tool-capture**: a2a-gateway: runtime tool schema needs registration capture
  - state: open · compat:none
  - evidence:
    - registerTool @ index.ts:777

## Upstream Metadata Issues

_none_

## Hard Breakages

_none_

## Target OpenClaw Compat Records

| Metric                   | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configured path          | /Users/vincentkoc/GIT/_Perso/openclaw                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Status                   | ok                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Compat registry          | ../../openclaw/src/plugins/compat/registry.ts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Compat records           | 56                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Compat status counts     | active:13, deprecated:43                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Record ids               | activation-agent-harness-hint, activation-capability-hint, activation-channel-hint, activation-command-hint, activation-config-path-hint, activation-provider-hint, activation-route-hint, agent-harness-id-alias, agent-harness-sdk-alias, agent-tool-result-harness-alias, approval-capability-approvals-alias, bundled-channel-config-schema-legacy, bundled-plugin-allowlist, bundled-plugin-enablement, bundled-plugin-load-path-aliases, bundled-plugin-vitest-defaults, channel-env-vars, channel-exposure-legacy-aliases, channel-mention-gating-legacy-helpers, channel-native-message-schema-helpers, channel-route-key-aliases, channel-runtime-sdk-alias, channel-target-comparable-aliases, clawdbot-config-type-alias, command-auth-status-builders, disable-persisted-plugin-registry-env, embedded-harness-config-alias, generated-bundled-channel-config-fallback, hook-only-plugin-shape, legacy-before-agent-start, legacy-extension-api-import, legacy-implicit-startup-sidecar, legacy-root-sdk-import, memory-split-registration, openclaw-schema-type-alias, plugin-activate-entrypoint-alias, plugin-install-config-ledger, plugin-owned-web-fetch-config, plugin-owned-web-search-config, plugin-owned-x-search-config, plugin-registry-install-migration-env, plugin-sdk-test-utils-alias, plugin-sdk-testing-barrel, provider-auth-env-vars, provider-discovery-hook-alias, provider-discovery-type-aliases, provider-external-oauth-profiles-hook, provider-static-capabilities-bag, provider-thinking-policy-hooks, provider-web-search-core-wrapper, runtime-config-load-write, runtime-inbound-envelope-alias, runtime-stt-alias, runtime-subagent-get-session-alias, runtime-taskflow-legacy-alias, setup-runtime-fallback |
| Hook registry            | ../../openclaw/src/plugins/hook-types.ts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Hook names               | 35                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| API builder              | ../../openclaw/src/plugins/api-builder.ts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| API registrars           | 48                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Captured registration    | ../../openclaw/src/plugins/captured-registration.ts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Captured registrars      | 26                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Package metadata         | ../../openclaw/package.json                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Plugin SDK exports       | 292                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Manifest types           | ../../openclaw/src/plugins/manifest.ts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Manifest fields          | 35                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Manifest contract fields | 17                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Warnings

| Fixture     | Code                   | Level   | Message                                    | Evidence                              | Compat record          |
| ----------- | ---------------------- | ------- | ------------------------------------------ | ------------------------------------- | ---------------------- |
| a2a-gateway | legacy-root-sdk-import | warning | fixture imports the root plugin SDK barrel | openclaw/plugin-sdk @ src/types.ts:14 | legacy-root-sdk-import |

## Suggestions To OpenClaw Compat Layer

| Fixture     | Code                                 | Level      | Message                                                                                                      | Evidence                                                                                                                                                                                                                     | Compat record |
| ----------- | ------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| a2a-gateway | package-typescript-source-entrypoint | suggestion | package OpenClaw entrypoint resolves to TypeScript source in this fixture checkout                           | extension:index.ts                                                                                                                                                                                                           | -             |
| a2a-gateway | package-dependency-install-required  | suggestion | package declares runtime dependencies that must be installed before cold import                              | @a2a-js/sdk @ package.json, @bufbuild/protobuf @ package.json, @grpc/grpc-js @ package.json, express @ package.json, multicast-dns @ package.json, uuid @ package.json, ws @ package.json                                    | -             |
| a2a-gateway | registration-capture-gap             | suggestion | future inspector capture API should record lifecycle, route, gateway, command, and interactive registrations | registerGatewayMethod @ index.ts:616, registerGatewayMethod @ index.ts:622, registerGatewayMethod @ index.ts:631, registerGatewayMethod @ index.ts:657, registerGatewayMethod @ index.ts:669, registerService @ index.ts:857 | -             |
| a2a-gateway | runtime-tool-capture                 | suggestion | tool shape is only visible after runtime registration capture                                                | registerTool @ index.ts:777                                                                                                                                                                                                  | -             |

## Issue Findings

- P1 **a2a-gateway** `inspector-gap` `inspector-follow-up`
  - **registration-capture-gap**: a2a-gateway: runtime registrations need capture before contract judgment
  - state: open · compat:none
  - evidence:
    - registerGatewayMethod @ index.ts:616
    - registerGatewayMethod @ index.ts:622
    - registerGatewayMethod @ index.ts:631
    - registerGatewayMethod @ index.ts:657
    - registerGatewayMethod @ index.ts:669
    - registerService @ index.ts:857

- P2 **a2a-gateway** `deprecation-warning` `core-compat-adapter`
  - **legacy-root-sdk-import**: a2a-gateway: root plugin SDK barrel is still used by fixtures
  - state: open · compat:deprecated · deprecated
  - evidence:
    - openclaw/plugin-sdk @ src/types.ts:14

- P2 **a2a-gateway** `inspector-gap` `inspector-follow-up`
  - **package-dependency-install-required**: a2a-gateway: cold import requires isolated dependency installation
  - state: open · compat:none
  - evidence:
    - @a2a-js/sdk @ package.json
    - @bufbuild/protobuf @ package.json
    - @grpc/grpc-js @ package.json
    - express @ package.json
    - multicast-dns @ package.json
    - uuid @ package.json
    - ws @ package.json

- P2 **a2a-gateway** `inspector-gap` `inspector-follow-up`
  - **package-typescript-source-entrypoint**: a2a-gateway: cold import needs TypeScript source entrypoint support
  - state: open · compat:none
  - evidence:
    - extension:index.ts

- P2 **a2a-gateway** `inspector-gap` `inspector-follow-up`
  - **runtime-tool-capture**: a2a-gateway: runtime tool schema needs registration capture
  - state: open · compat:none
  - evidence:
    - registerTool @ index.ts:777

## Contract Probe Backlog

- P1 **a2a-gateway** `inspector-capture-api`
  - contract: External inspector capture records service, route, gateway, command, and interactive registrations.
  - id: `api.capture.runtime-registrars:a2a-gateway`
  - evidence:
    - registerGatewayMethod @ index.ts:616
    - registerGatewayMethod @ index.ts:622
    - registerGatewayMethod @ index.ts:631
    - registerGatewayMethod @ index.ts:657
    - registerGatewayMethod @ index.ts:669
    - registerService @ index.ts:857

- P2 **a2a-gateway** `package-loader`
  - contract: Inspector installs package dependencies in an isolated workspace before cold import.
  - id: `package.entrypoint.isolated-dependency-install:a2a-gateway`
  - evidence:
    - @a2a-js/sdk @ package.json
    - @bufbuild/protobuf @ package.json
    - @grpc/grpc-js @ package.json
    - express @ package.json
    - multicast-dns @ package.json
    - uuid @ package.json
    - ws @ package.json

- P2 **a2a-gateway** `package-loader`
  - contract: Inspector can compile or load TypeScript source entrypoints before registration capture.
  - id: `package.entrypoint.typescript-loader:a2a-gateway`
  - evidence:
    - extension:index.ts

- P2 **a2a-gateway** `sdk-alias`
  - contract: Root plugin SDK barrel remains importable or has a machine-readable migration path.
  - id: `sdk.import.root-barrel-cold-import:a2a-gateway`
  - evidence:
    - openclaw/plugin-sdk @ src/types.ts:14

- P2 **a2a-gateway** `tool-runtime`
  - contract: Registered runtime tools expose stable names, input schemas, and result metadata.
  - id: `tool.registration.schema-capture:a2a-gateway`
  - evidence:
    - registerTool @ index.ts:777

## Fixture Seam Inventory

| Fixture     | Priority | Seams          | Hooks | Registrations                                        | Manifest contracts |
| ----------- | -------- | -------------- | ----- | ---------------------------------------------------- | ------------------ |
| a2a-gateway | high     | plugin-runtime | -     | registerGatewayMethod, registerService, registerTool | -                  |

## Decision Matrix

| Fixture     | Decision            | Seam                 | Action                                                                                               | Evidence                                                                         |
| ----------- | ------------------- | -------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| a2a-gateway | inspector-follow-up | cold-import          | Compile TypeScript source or run a loader before cold-importing this fixture entrypoint.             | index.ts                                                                         |
| a2a-gateway | inspector-follow-up | cold-import          | Install runtime dependencies in an isolated workspace before executing this fixture entrypoint.      | @a2a-js/sdk, @bufbuild/protobuf, @grpc/grpc-js, express, multicast-dns, uuid, ws |
| a2a-gateway | core-compat-adapter | sdk-import           | Keep the root SDK barrel stable or expose a machine-readable migration map before removing aliases.  | openclaw/plugin-sdk                                                              |
| a2a-gateway | inspector-follow-up | registration-capture | Expose or mirror a full public API capture shim before treating these runtime-only seams as covered. | registerGatewayMethod, registerService                                           |
| a2a-gateway | inspector-follow-up | tool-schema          | Capture registered tool schemas from plugin register() before judging tool compatibility.            | registerTool without manifest contracts.tools                                    |

## Raw Logs

| Fixture     | Code                    | Level | Message                                                                          | Evidence                                                                                    | Compat record          |
| ----------- | ----------------------- | ----- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------- |
| a2a-gateway | seam-inventory          | log   | observed 0 hooks, 3 registrations, and 0 manifest contracts                      | registration:registerGatewayMethod, registration:registerService, registration:registerTool | -                      |
| a2a-gateway | hook-names-present      | log   | all observed hooks exist in the target OpenClaw hook registry                    | -                                                                                           | -                      |
| a2a-gateway | api-registrars-present  | log   | all observed api.register* calls exist in the target OpenClaw plugin API builder | registerGatewayMethod, registerService, registerTool                                        | -                      |
| a2a-gateway | sdk-exports-present     | log   | all observed plugin SDK imports exist in target OpenClaw package exports         | openclaw/plugin-sdk                                                                         | -                      |
| a2a-gateway | manifest-fields-checked | log   | plugin manifest fields were compared with target OpenClaw manifest types         | openclaw.plugin.json                                                                        | -                      |
| a2a-gateway | package-metadata        | log   | selected package metadata for plugin contract checks                             | package.json, openclaw-a2a-gateway, version:1.4.0                                           | -                      |
| a2a-gateway | compat-record-present   | log   | target OpenClaw checkout has a matching compat registry record                   | legacy-root-sdk-import, status:deprecated                                                   | legacy-root-sdk-import |
