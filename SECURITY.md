# Security policy

This policy covers **HAPI-eVolved**, maintained in
[BGGBTAC/hapi-evolved](https://github.com/BGGBTAC/hapi-evolved). Report issues in
this fork here; upstream HAPI maintainers are not the support or security team
for this project.

## Reporting a vulnerability

Do not disclose suspected vulnerabilities in a public issue or pull request.
Do not upload real credentials, bootstrap tokens, recovery codes, private keys,
session cookies, production databases or private chat/workspace content, even
when reporting privately. Use synthetic examples and redact sensitive values.

GitHub private vulnerability reporting requires a **public repository with the
feature explicitly enabled**. This file does not enable it. See
[GitHub's reporting instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately).

If the repository's Security page offers **Report a vulnerability**, use the
[private reporting form](https://github.com/BGGBTAC/hapi-evolved/security/advisories/new).
Check that you are submitting a private vulnerability report before adding details.
This link may be unavailable while the repository is private or reporting is disabled.

If that channel is unavailable, use the repository's
[support request form](https://github.com/BGGBTAC/hapi-evolved/issues/new?template=support.yml)
with the topic **Private contact request**. Say only that you need a private
security-reporting channel. Do not include the affected component, exploit,
reproduction, deployment identifiers or sensitive attachments. Wait for a
repository maintainer to arrange a private channel, and verify their repository
role before sending details. No separate security email address is published here.

Once a private channel is established, provide:

- The affected Evolved version and source commit, plus relevant component versions.
- A minimal reproduction against an isolated installation using synthetic data.
- The required access, expected security boundary and observed impact.
- Any proposed fix or mitigation and the checks you used to evaluate it.

Please coordinate public disclosure with maintainers so users can receive a fix
or mitigation. There is no guaranteed response time, remediation deadline or
bug-bounty program.

## Preview scope and updates

The 0.1.0 preview and current development branch are the focus of security
maintenance. There is no long-term-support or historical-release backport
commitment. Report a suspected issue even if you cannot reproduce it on the
latest commit; include the version you actually tested.

The documented preview is a fresh Linux installation with Web/PWA access and
Claude Code/Codex project runners. The
[deployment guide](docs/evolved/DEPLOYMENT.md) describes security assumptions,
credential handling, backup/restore and upgrade procedures. The
[validation notes](docs/evolved/VALIDATION.md) record tested behavior and remaining
limits. Security profiles and container restrictions are not a guarantee that
arbitrary agent code is safe.

For ordinary installation questions and non-security defects, use
[SUPPORT.md](SUPPORT.md).
