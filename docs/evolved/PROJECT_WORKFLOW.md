# Integrated project workflow

The next HAPI-eVolved milestone connects the existing project tools into a usable
sequence: choose the working repository, inspect changes, examine code relationships,
request an agent review, and preserve selected knowledge for the next session.
It extends the Linux/Docker/Web preview; it does not change the supported platforms.

## Planning and independent design review

On 2026-10-15, Claude Fable 5.1 received the project overview, current source evidence,
existing features, previous acceptance results, and the user's priorities. The model
was invoked through Claude Code using `--model fable`; the returned usage metadata
identified `claude-fable-5-1`. A second planning pass corrected assumptions against
backend and frontend inventories. Claude Opus 5.5 then reviewed the final plan and
relevant source through `--model claude-opus-5-5`; usage metadata confirmed that model.
Both consultations were tool-free: repository content was input data, not instructions.

The source tree was `7c1ea7d1ec55ec172ffa5142d956f82bd64975ca`, shared by the reviewed
Dependabot branch and main merge `4515385d65a60f728081d28483c94e7657f06ade`.
The evidence manifest is in [reviews/project-workflow-2026-10-15.json](reviews/project-workflow-2026-10-15.json).
These consultations inform the implementation; they are not a security certification.

| Selected function | Functionality (1–6) | Feasibility (1 hard–6 easy) | Project benefit |
| --- | ---: | ---: | --- |
| Project readiness | 5 | 4 | Distinguish a connected service from a working connection and native login. |
| Explicit repository context | 5 | 4 | Start an ordinary session or specialist in the selected checkout without copying paths. |
| Repository worktree and diff | 5 | 3 | Inspect local changes without starting a model session. |
| Change impact and review | 4 | 4 | Feed checked paths to Codegraph and start an explicit review in the same repository. |
| Source-linked knowledge proposals | 4 | 4 | Save a stored message or current source file without entering source IDs manually. |

## Implementation decisions

- The default working directory remains the saved project root. Repository context is
  an explicit selection. The server resolves the repository ID from current grants;
  it does not accept an arbitrary checkout path or create missing directories.
- Session-to-repository links belong to the Hub. Runner-written metadata is not an
  authority for repository grants or provenance.
- Worktree and diff reads use the existing restricted machine repository RPC with a
  separately advertised capability. Older runners report that an update is required.
  Reading does not fetch, stage, commit, pull, or push.
- The browser reuses the existing unified diff presentation. Untracked files are
  listed without a content preview. Large patches are withheld as a whole. Binary,
  excluded, unavailable, and changed states are distinct from a clean worktree.
  Submodule working trees are not inspected; changes inside them need a separate
  review. The browser shows this limitation beside the repository status.
- A worktree snapshot detects changes to the observed repository state. It is not a
  transactionally frozen checkout. Other authorized processes may still modify it.
- Codegraph accepts project-relative paths derived from the selected checkout.
  Deleted, excluded, unsupported, and excess paths are reported as skipped. Test
  candidates are filename-based hints, not coverage or test execution results.
- Review specialists use the provider's planning/read-only mode. This does not
  establish OS isolation between sessions sharing a runner user.
- Message proposals use stored Hub text, optionally a server-selected contiguous
  excerpt. Arbitrary rewritten text uses the existing manual proposal workflow.
  The source hash retains the existing raw Hub-envelope semantics so later automatic
  ingestion does not invalidate a proposal merely because of a different projection.
- New file intake and diff views share a conservative sensitive-path and credential
  policy. Matching content is withheld entirely. Pattern matching cannot identify
  every possible secret. Legacy knowledge reconciliation keeps its original policy
  so a wider new intake filter does not silently delete existing knowledge.
- A file-backed fact follows the existing lifecycle: changing or removing its source
  removes the derived fact. Proposals are not automatically verified, and these UI
  actions do not enable cloud processing or increase its budget.
- Readiness consumes local checks, an empty RPC probe, existing diagnostic routes,
  and the background Codegraph status snapshot. It never provisions a service or
  starts a model prompt. Provider login diagnostics remain administrator-only.

## Subsequent candidates

These are future work, not claims about this milestone. Historical backlog reviews
remain unchanged. Their original scores are not silently rewritten as completion.

| Candidate | Functionality / feasibility | Reason for a separate change |
| --- | --- | --- |
| Codegraph worker fairness and idle release | 5 / 3 | Requires load and memory measurements under the container limit before supporting more concurrent indexed projects. |
| Cross-project knowledge search and pagination | 4 / 4 | Needs explicit multi-project source navigation and authorization tests. |
| Native Claude completion reports | 4 / 3 | Needs a reliable turn-end identity contract, separate from Codex reporting. |
| Failed-clone recovery | 5 / 3 | Needs a preservation-first design for existing directories and interrupted jobs. |
| Browser PR/check status | To assess | Extends the current Git transport authority to GitHub REST or an App installation. |
| Static build-artifact discovery, push notifications, dev-server previews | To assess | Separate lifecycle, resource, and publication decisions. |
| Session isolation | To assess | An execution-boundary change; permission prompts alone cannot provide it. |

Existing Dependabot quiet mode remains in effect. No new automatic update-PR stream
is part of this milestone.
