# Packed package validation

`npm run package:check` validates the same tarball users install, with a temporary
installation that has its own `node_modules` and resolves the package's declared
runtime dependencies normally. It does not link to the checkout's dependencies
or install anything globally.

The check packs the project, installs the tarball in a temporary directory, and
runs the installed CLI's help and version commands. It then creates a synthetic
T3 0.1.1 database with the pinned runtime included in the package, writes a
synthetic Codex rollout under a temporary `CODEX_HOME`, and invokes the installed
CLI to import one turn, sync a second and repeat sync without duplicating history.
It checks the expected messages, schema migration, database integrity, foreign
keys and absence of queued provider effects. The database, source fixture, and
import ledger live only under that temporary directory and are removed at exit.
No live `.t3`, Codex, Claude Code, or OpenCode data is accessed.

CI runs this check on Windows, macOS, and Ubuntu with Node.js 22 and 24. It also
runs typecheck and the full test suite in each matrix job. The CI workflow also
accepts manual dispatch for a chosen branch. Run the package check
locally with a supported Node.js release:

```sh
npm run package:check
```

Validated on macOS with Node.js 24.19.0 on 22 October 2026. This local result does
not stand in for the Windows/Linux or Node.js 22 CI jobs.
