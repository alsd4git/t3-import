# Runtime maintenance

By default, import, sync, replacement and cache reset require T3 to be closed.
Inspect a server without changing it or loading provider histories:

```sh
t3-import runtime status
t3-import runtime status --json
```

The report distinguishes `idle`, `busy` and `unknown` using a consistent read-only
database snapshot. It checks unfinished runs and attempts, provider sessions,
approvals/input requests, background work, launch workflows, effects and due or
running scheduled tasks. Future schedules produce a warning and do not count as
active work. Unsupported schemas and malformed activity data are `unknown`.

## Optional stop and restart

On Linux, the interactive importer offers **s** when it finds an idle runtime
owned by a verified systemd service. A second screen asks for confirmation and
explains that T3 Connect clients will disconnect. Otherwise, close T3 manually.

For scripts, explicitly opt in:

```sh
t3-import --manage-runtime sync --all --yes --non-interactive --summary
t3-import --manage-runtime import --source codex --workspace /path/to/project --all --yes --non-interactive
```

The importer verifies that the recorded PID holds the selected database open,
checks its process start time, cgroup and parent chain, and identifies the owning
user or system service. It refuses services with activation triggers. It uses
`systemctl stop` and `systemctl start` on that same unit, preserving its launcher,
environment and restart policy. It never reconstructs a command from process
arguments, kills the server PID, or invokes sudo. System units must already be
manageable without an interactive authorization prompt.

Activity is a snapshot, not a lock against new requests. The importer checks again
before stopping and after the service has fully stopped, comparing durable work
identities to detect work that arrived during shutdown. A changed snapshot
refuses database writes and restores the service. Avoid submitting new work during
maintenance; clients and future scheduled tasks remain unavailable until restart.

Restoration runs after success, errors, TUI cancellation, Ctrl+C and SIGTERM. An
operation already writing data finishes before restoration. The command waits for
the same service's runtime to respond before exiting. JSON output is emitted after
restoration; a restart failure reports an error and preserves the operation result.
`--dry-run` never stops T3. A service that was initially stopped stays stopped.

## Recovery

Before stopping, the importer creates an exclusive, private recovery record:
`<state-directory>/.t3-import-maintenance.json`. It removes the record only after
the service is ready again. Restart errors retain it and print the exact recovery
command, for example:

```sh
systemctl --user start t3code.service
```

SIGKILL, machine shutdown and loss of the importer process can prevent automatic
restoration. Inspect the record, start the recorded service, and check
`t3-import runtime status`. Remove the record only after confirming that no
maintenance command still owns it and recovery is complete. A new maintenance
command refuses to overwrite an existing record.

## Development verification

On Linux with a working user systemd manager, run against a built checkout or an
installed package directory:

```sh
npm run build
node scripts/runtime-service-check.mjs .
```

This creates a uniquely named temporary user service, a synthetic HTTP runtime,
isolated T3 and Codex homes, and a T3 0.1.1 fixture database. It tests real systemd
ownership, import and restore, error restoration, TUI cancellation, SIGTERM and
busy refusal. It cleans up its own service and fixtures, without stopping
`t3code.service` or modifying real conversations.
