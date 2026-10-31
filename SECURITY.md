# Security policy

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/alsd4git/t3-import/security/advisories/new).
Do not disclose exploit details or sensitive data in public issues or pull requests.

Include the affected commit or version, expected impact and minimal reproduction
steps. Use synthetic examples and redact screenshots and logs. If a credential
has been exposed, revoke or rotate it before sharing details.

## Versions and maintenance

Check the current default branch, `main`, and, if using a release,
the latest release published by this repository before reporting an issue.
Fixes, when provided, target the default branch. Older versions do not receive
separate backports. Reports are handled on a best-effort basis without guaranteed
response or remediation times.

## Safe reproduction

Use synthetic conversation files and temporary databases. Never attach real conversations, session databases, account tokens or private workspace paths.

This policy covers this fork and its maintained changes. Vulnerabilities specific
to the upstream project should also be reported through its own security channel.
