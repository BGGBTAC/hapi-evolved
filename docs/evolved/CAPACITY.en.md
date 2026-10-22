# Reported subscription capacity

[Deutsche Fassung](CAPACITY.md) · English

The project overview shows the usage windows that Claude Code and Codex actually
report. These limits apply **to the respective provider account**, even when the
report comes from a session in this project. They are neither a project budget nor
the sum of token costs incurred in HAPI.

Several sessions can use the same account or different accounts. HAPI shows their
reports separately and does not add them together. It does not transmit a provider
account ID, email address or credentials to match reports to accounts. "Remaining"
is strictly `100 − reported usage in percent`. A missing usage value produces no
remaining value. Only an explicitly reported 0 % usage results in 100 % remaining.

## Data sources

| Provider | Native interface used | Availability |
| --- | --- | --- |
| Codex | Local app server: `account/read`, `account/rateLimits/read`, `account/rateLimits/updated` | Requires a ChatGPT sign-in and a Codex version that supports it |
| Claude | Structured `rate_limit_event` from the already running Claude SDK process | Only the windows and fields the SDK actually delivers |

After initialization or reconnection, Codex reads the account type and the
reported limits. An existing app server is then read again every 60 seconds;
each RPC runs for at most five seconds. Change events appear without waiting for
this interval. The capacity view does not start or connect an agent process on
its own. API-key sign-ins are explicitly not supported for this **subscription**
view.

Claude reports, for example, a five-hour window, a weekly window or model-specific
weekly windows. `utilization` is optional: "allowed" means that requests are
permitted; it does not prove any free percentage. Without a numeric value the
window stays unknown. HAPI does not query private OAuth HTTP endpoints for this and
does not send a paid test message. The optional `overage` window denotes additional
usage and is not additional free subscription budget. Local PTY/ACP sessions
without integrated structured capacity reports also remain unknown.

Sign-in uses the native CLI flow; for managed projects, use
[Connect subscriptions](PROVIDER_LOGIN.md) in the browser. The capacity view sets
up no additional provider credentials, reads no credential files and delivers no
tokens to the browser.

Official protocol sources, checked on 15 October 2026 (as recorded in the German
guide):

- [OpenAI: Codex App Server, accounts and rate limits](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt): `usedPercent`, `windowDurationMins`, `resetsAt` and single and multiple limit buckets.
- [Anthropic: official Agent SDK types](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py): `RateLimitInfo` and `RateLimitEvent`, in particular optional utilization as a fraction between 0 and 1.

## Freshness and limits

Each window carries its own receipt time. Partial reports replace only the windows
actually reported and keep other windows with their original time. Empty or invalid
partial reports change neither the windows nor their timestamps; an explicit `null`
removes the affected Codex window. A complete Codex read replaces the complete Codex
snapshot. Account switches and native restarts discard the previous association;
late responses from an older account generation do not overwrite a newer report.

A window is stale when its session is inactive, its report is at least five minutes
old, or the reported reset time has been reached. HAPI does **not** reset usage to
zero by itself after expiry. The old value remains recognizable as stale until the
provider delivers a new value. Implausible future receipt times do not produce a
fresh display.

A fresh window can appear next to a stale window. The provider status is
`available` only when at least one fresh numeric value exists. `unknown` means
missing, stale or non-numeric reports, or a failed native read. `unsupported`
denotes a recognized sign-in that is not supported for subscription capacity. HAPI
does not estimate token counts from these percentages.

## Project-scoped read API

`GET /api/evolved/projects/:id/capacity` requires a human sign-in and at least the
current project role `viewer`. Runner capabilities grant no access to this endpoint.
The hub reads only sessions in the authorized project namespace and returns
`Cache-Control: private, no-store`. A revoked permission takes effect on the next
request. The browser request loads the most recently received reports; it does not
force a direct provider query.

The shared TypeScript contract is called `ProjectCapacity` and is exported from
`@hapi/protocol`. All time fields use Unix milliseconds; native provider timestamps
are converted from seconds.

```ts
{
  projectId: string,
  generatedAt: number,
  providers: [{
    provider: 'claude' | 'codex',
    status: 'available' | 'unknown' | 'unsupported',
    reports: [{
      sessionId: string,
      source: 'claude-sdk' | 'codex-app-server',
      scope: 'account',
      observedAt: number,
      status: 'available' | 'unknown' | 'unsupported',
      reason: string | null,
      stale: boolean,
      windows: [{
        id: string,
        observedAt: number,
        usedPercent: number | null,
        remainingPercent: number | null,
        resetsAt: number | null,
        durationMinutes: number | null,
        status: 'allowed' | 'warning' | 'rejected' | 'unknown',
        stale: boolean
      }]
    }]
  }]
}
```

`observedAt` is the time HAPI received a report, not a provider timestamp;
`resetsAt` is the reset time reported by the provider. Empty `reports` are an
unknown state. Failure reasons are fixed codes: `not_reported`,
`utilization_not_reported`, `native_read_failed`, `authentication_required`,
`subscription_auth_required` and `invalid_report`. Raw responses and provider
error messages are not part of the response. These reports are operational
information from the connected CLI, not billing cryptographically attested by the
provider, and not a guaranteed quota.
