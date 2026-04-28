# OpenClaw Plugin Issue Findings

Generated: deterministic
Status: PASS

## Triage Summary

| Metric               | Value |
| -------------------- | ----- |
| Issue findings       | 5     |
| P0                   | 0     |
| P1                   | 1     |
| Live issues          | 0     |
| Live P0 issues       | 0     |
| Compat gaps          | 0     |
| Deprecation warnings | 1     |
| Inspector gaps       | 4     |
| Upstream metadata    | 0     |
| Contract probes      | 5     |

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

## Issues

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
