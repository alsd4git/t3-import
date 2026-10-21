# OpenCode continuation, 22 October 2026

The user authorized a bounded real continuation check on an existing linked
OpenCode conversation. One diagnostic prompt requested only a fixed marker,
with no tools, file changes or further work. It was dispatched through T3's
supported thread-send operation, using the same application orchestration path
as a user message. This check did not simulate a manual click in the UI.

The T3 run completed. The existing native OpenCode session contained the marker
in its new assistant output, and T3's current native reference still pointed to
that same session. Four native message records were added. The previous native
message contents, model/variant, project, directory and parent/fork references
were preserved. Private evidence with exact IDs and before/after records is
kept in local ignored artifacts rather than this repository.

The check exercises continuation of an already-linked native session. It does
not establish that an arbitrary newly imported transcript is resumable from a
manual UI action. Packaged import/sync and native adoption remain covered by
isolated tests; cross-provider transfer and automatic history merging are outside
the supported workflow.

## Title behavior discovered

The T3 0.1.1 OpenCode adapter calls its supported session update operation with
the app thread's title on resume. In this check that replaced the provider-only
`[T3]` prefix with the local T3 title. The previously approved OpenCode title was
restored through `opencode api session.update`, then verified with `session.get`.
The application-local title was unchanged.

This is a T3 adapter behavior, not a transcript-import side effect. A separate
naming audit can restore provider markers after continuation. No background
renamer or modification of the bundled upstream runtime was introduced.
