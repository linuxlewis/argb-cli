# Agent Guide

This repository is set up for agent-first changes.

## Goal

Build a TypeScript CLI that can interact with ARGB devices through a stable transport abstraction. The current transports are mock and file-backed harnesses; future hardware transports should plug into the same interface.

## Useful Commands

```bash
npm run verify
npm run typecheck
npm test
npm run build
npm run dev -- list
npm run dev -- run-plan harness/plans/boot-glow.json
```

## Working Rules

- Prefer adding behavior in `src/core` or `src/harness` before changing CLI output.
- Keep transport implementations behind `src/transports/types.ts`.
- Add tests for plan validation, command execution, and device state changes.
- Keep harness fixtures deterministic. Do not require real ARGB hardware for CI or local verification.

## Completion Checklist

- `npm run verify` passes.
- New commands have README usage and at least one test.
- New transport behavior is testable through the mock or file harness.
