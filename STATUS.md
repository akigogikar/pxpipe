# pxpipe closeout status

**Final state:** maintenance-only as of 2026-07-11.  
**Owner:** none assigned.  
**Canonical preservation branch:** `maintenance/closeout-2026-07-11`.

## Preserved state

- The local branch includes the three commits that were ahead of `fork/main`.
- The dashboard/API work that was previously uncommitted is preserved in this
  branch: dashboard rendering/fragments/types and the dashboard API tests.
- The passthrough/Opus guardrail work remains separately preserved at
  `feat/collapse-fail-passthrough-and-opus-guardrails` (`2d071d4`). It is not
  merged here.

## Last verification

- `./node_modules/.bin/vitest run tests/dashboard-api.test.ts --reporter=dot`:
  29/29 passed.
- `./node_modules/.bin/tsc --noEmit`: passed.
- The installed dependency tree could be used directly. The bundled pnpm 11
  wrapper tried to replace modules for this pnpm 10 project and aborted in a
  non-interactive shell, so that wrapper path is not claimed as verified.

## What is settled

- Routing and compression work for supported traffic.
- The LaunchAgent/KeepAlive restart loop was repaired.
- Observed Opus traffic is unsupported and may pass through uncompressed; do
  not describe it as covered by the compression path.

## Remaining risks

- The guardrail branches have not been integrated into the maintenance branch.
- Upstream PR state and the MITM direction must be live-verified before action.
- Generated `.codesight/` data remains local and is not part of the preserved
  product change.

## Maintenance policy and resume condition

Accept only necessary compatibility, security, and reliability fixes. Resume
roadmap work only with a named owner and a concrete protocol/routing milestone.
The first resumed task should live-verify Opus/passthrough behavior and decide
whether the existing guardrail branch should be merged, rewritten, or closed.
