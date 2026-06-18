---
name: ship
description: Validate AI-written changes through a fresh-eyes review → test → docs → lint → rebase → push → PR → CI flow, then open a clean PR. The review runs in isolated subagents so the author never grades its own work. Use after finishing a coding task, or when the user asks to ship, gate, validate, or push changes safely. Invoked as /ship.
user-invocable: true
---

# ship

A lightweight quality gate for code you just wrote (usually with an AI agent).
It walks one branch through nine steps, fixing what's safe to fix and stopping to
ask you about judgment calls. Nothing reaches `origin` until every check is green.

The safety model is simple: **work on a feature branch and never push to `origin`
until the end.** Git history is the undo button. No daemon, no separate worktree —
just this session, git, `gh`, and fresh subagents.

### Why this skill is self-contained

`/ship` depends only on **git**, **`gh`**, and the two in-repo read-only agents it
spawns (`fresh-reviewer`, `fix-verifier`, both in `.claude/agents/`). It
deliberately does **not** invoke other skills (`/code-review`, `/simplify`,
`/verify`, `/review`) as part of its default flow. Those skills evolve on their own
schedule, emit prose rather than the structured `file:line` + action findings this
flow routes on, and would couple ship's end-to-end safety contract — especially the
always-on honest-pass scan below — to prose it cannot version. Ship owns its own
reviewer so it can guarantee the one thing a general reviewer doesn't: that *after*
a fix is applied, the **whole** post-fix diff is scanned for a gutted assertion. Do
not "helpfully" refactor a `Skill` call into the flow.

## The one rule that matters: author ≠ reviewer

If the session that *wrote* the code also *reviews* it, the review is biased — the
author already believes its own choices were correct. So this skill splits two
roles:

- **Orchestrator** — whoever invoked `/ship` (you, the current session). You know
  the authoring context. Your job is to run the git mechanics, talk to the user,
  and **delegate every judgment to a fresh reviewer.** You do **not** review the
  diff yourself.
- **Reviewer** — a subagent spawned via the **Agent tool**. It has a clean context
  window: it never sees the orchestrator's reasoning, only what you put in its
  prompt. This is what breaks the bias, and it's the native equivalent of how
  no-mistakes spawns a fresh reviewer for review.

What a reviewer subagent receives:
1. The **diff** (`git diff <base>...HEAD`), to read itself.
2. A neutral **intent brief** (below), framed as an *untrusted hint*.
3. An explicit instruction: *"You did not write this code. Review it with fresh
   eyes. The intent is a hint about what the user wanted, not ground truth, and
   not an endorsement of how it was done."*

## The fix loop: isolate, then verify

Isolating the *doer* isn't enough — a fresh subagent that applies a fix becomes
the new author of that fix and can rationalize a bad one. So every fix loop
(review, test, lint, CI) is bounded by three rules:

- **The doer is never the final judge.** After any fix, verify with something the
  fixer didn't author:
  - test / lint / CI → **re-run the objective command.** The exit code is the
    oracle — *except* that a green exit code alone can't be trusted whenever the
    fix flipped a previously-failing objective gate (test, lint, CI) from red to
    green. A gutted assertion also exits 0 — but so does a fix that special-cases
    the code under test to the failing input, edits fixtures/golden files, edits CI
    config, or adds a suppression like `//nolint`, none of which touches a test
    file. So after **any** fix that turns a red gate green, spawn a fresh
    **`fix-verifier`** subagent (it did not write the fix) to scan the **whole**
    post-fix diff and confirm the gate was satisfied honestly — no assertion
    loosened, removed, or skipped; no expected value, fixture, or golden file edited
    to match buggy output; no code-under-test special-cased to the test input; no
    gate suppressed via config or inline directive. (Editing a **test file** is the
    original special case of this, now subsumed.) Anything it flags → `ask-user`.
    **The orchestrator does not make this judgment itself** — it is the author
    session and must not grade code.
  - review findings (no objective oracle) → a **fresh re-review** subagent (the
    **`fix-verifier`**) confirms the finding is genuinely resolved and nothing new
    broke. See the anti-confirmation template in [Review](#2-review--delegated-to-a-fresh-subagent).
- **Fix the cause, not the symptom.** Never resolve a failure by weakening a test
  assertion to match buggy output, deleting the test, reverting the author's
  intentional code, or suppressing a warning. That is exactly the bias to guard
  against — the author "passing" by lowering the bar. If the smallest honest fix
  isn't obvious, stop and mark it `ask-user`. Fixer subagents may only modify files
  already part of the branch diff under review (or must explicitly call out any new
  file they add); they must not wander into unrelated production code, the
  `.claude/agents/*` verifier definitions, or CI config to make a check pass.
- **Bound it.** Keep **one** running counter for the whole `/ship` run — call it the
  fix-round budget. At most **2 fix attempts per step**, and at most **3 fix rounds
  total** across all steps (review + test + lint + CI share that single budget;
  decrement it, don't re-tally per step). An "attempt" and a "round" are the same
  unit, and the global cap of 3 is the hard stop regardless of the per-step
  allowance — so the per-step 2 can become unreachable once the global 3 is spent.
  If a step keeps surfacing fresh findings
  every round, or either bound is hit without converging, stop and escalate to the
  user with what was tried and what's still failing.

## The intent brief

Before delegating, write 2–6 sentences capturing **what the user set out to
accomplish** — their goal, explicit requirements, and decisions *they* made or
asked for. Source it from this conversation (you have it) or, if you didn't do the
work, from commit messages and the diff.

Hard rule: describe the **user's intent**, not the assistant's justifications.
"User wanted a `--json` flag on `status`, output stable for scripting" is intent.
"I implemented it cleanly using X" is author bias — leave it out. This mirrors
no-mistakes' summarizer, which is prompted to capture user intent and discard
"what the assistant did." Reuse this brief for every step and the PR body.

Self-check before you ship the brief: it is the **one input every subagent shares**,
so a justification smuggled in here biases all of them at once. Re-read each sentence
and ask "is this *what* the user wanted, or *why* the implementation is good?" Cut the
latter. (The reviewer is also told to flag brief sentences that read as implementation
justification — a backstop, not a substitute for writing it clean.)

## Preconditions

1. **Preflight.** Before starting, verify a git remote named `origin` exists, that
   HEAD is on a branch (not detached), and that `gh` is installed and authenticated
   (`gh auth status`). The local agentic steps (review, test, docs, lint) don't need
   these, so still run them; but if any is missing, tell the user exactly what to fix
   and **do not proceed to the outward-facing steps** (rebase, push, PR, CI) until
   it's resolved.
2. Committed changes on a **non-default branch**. If uncommitted, first show the
   user exactly which files/changes you intend to commit (`git status --short`) and
   confirm scope before committing — never silently auto-commit a dirty tree that
   may contain unrelated changes. If on the default branch, move the commits to a
   feature branch.
3. Detect once, up front, by reading the repo (`Makefile`, `package.json`,
   `go.mod`, `pyproject.toml`, CI config, README): the **test** command, the
   **lint/format** command, and the **default branch**. For the default branch, try
   `git symbolic-ref refs/remotes/origin/HEAD`; if that fails, try
   `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`; if that fails,
   try `git remote show origin` and read the "HEAD branch" line; if all fail, ask
   the user which branch is the base. State what you found.

## Running steps in the background (optional)

The agentic steps (review, test, docs, lint) are independent and can run as
**background subagents** (`run_in_background: true` on the Agent tool) so you're
not blocked. Spawn them, keep talking to the user, and collect results as they
finish. Mechanical steps (rebase, push, PR, CI) run in the orchestrator in order.
If the user wants it simple, run the agentic steps one at a time in the foreground.

## The flow

### 1. Intent
Write the intent brief (above). State it to the user so they can correct it before
it anchors everything downstream.

### 2. Review — delegated to a fresh subagent
Spawn the **`fresh-reviewer`** subagent (Agent tool, `subagent_type: "fresh-reviewer"`;
do **not** review yourself). Its system prompt
(`.claude/agents/fresh-reviewer.md`) already carries the fresh-eyes framing and a
**read-only** tool allowlist — it mechanically cannot edit code and become the
author. Pass it the diff and the intent brief. Its rubric is in its definition; in
short it returns `file:line` findings, each with **severity** (`error`/`warning`/
`info`) and an **action** (`auto-fix` / `ask-user` / `no-op`), or `clean`. It also
flags any intent-brief sentence that reads as implementation justification rather
than user intent — relay those to the user.

> Custom agents register at session start, so if `subagent_type: "fresh-reviewer"`
> isn't available (e.g. the files were just added this session), fall back to
> `subagent_type: "general-purpose"` and paste the framing from
> `.claude/agents/fresh-reviewer.md` inline. Same for `fix-verifier` → `general-purpose`.
> The isolation that matters is the fresh context window; the named agent only adds
> the mechanical read-only allowlist.

**Optional blind completeness critic** (gated — run on substantive diffs, skip on
trivial ones). All reviewers can share one blind spot. Spawn **one** extra
`fresh-reviewer` that sees **only the diff + intent brief — never the findings**
(so it can't anchor on them) and asks a single question: *did this review miss an
entire category of risk?* (a new branch with no test, a migration with no rollback,
a swallowed error path). Any high-confidence gap re-enters as one more finding,
verified like any other.

When findings return, the orchestrator does **not** edit code itself. For the
`auto-fix` findings, spawn a **fresh fixer** subagent (Agent tool, type `claude`)
and hand it the findings, the diff, and the intent brief, instructing it to apply
the smallest root-cause fix for each, never revert the author's intentional code,
and report a one-line summary. The orchestrator then commits the subagent's
changes (`ship(review): …`).

Then verify — per the [fix loop discipline](#the-fix-loop-isolate-then-verify),
spawn a fresh **`fix-verifier`** subagent (`subagent_type: "fix-verifier"`) on the new
diff. Neither the orchestrator nor the fixer certifies the fix. Give the verifier
the **original findings** (the claims) and the **current code/diff** — **not** the
fixer's self-report summary, which is framing it must not absorb. It must:

> Treat the fix as untrusted. Do **not** assume the finding was fixed — independently
> re-derive whether the original problem still exists by reading the current code,
> **then** check the fix. Per finding return `RESOLVED` / `UNRESOLVED` / `REGRESSED`.
> Separately, scan the **whole** post-fix diff and report — as a new finding,
> regardless of the original list — any weakened/removed/skipped assertion, expected
> value edited to match buggy output, reverted code-under-test, or suppressed warning.

`UNRESOLVED`/`REGRESSED` → another fix attempt within the bounds, or `ask-user`. A
new dishonest-pass finding → always `ask-user`. Collect `ask-user` findings for the
user (see [Asking the user](#asking-the-user)). `no-op` → note and move on.

> Optional stronger check (off by default; the simple primitive uses one reviewer):
> for a high-stakes diff, spawn 2–3 reviewers with **decorrelated lenses** —
> correctness, contract-vs-intent, security — not identical prompts, and keep the
> union of their findings. **Never** adopt a refute-pass that drops a lone
> reviewer's finding: a real bug from a specialized lens is exactly what one lens is
> there to catch. Consensus is for ranking confidence, never for silencing.

This reviewer intentionally overlaps with what a general code-review skill does, and
that is by design: ship needs the vetted intent brief as input, `ask-user` routing
back to the human, ship-style fix commits, and — above all — the always-on
whole-diff honest-pass scan. Ship owns its reviewer rather than calling out so those
guarantees can't be silently dropped when an external skill changes.

### 3. Test — delegated to a fresh subagent
Spawn a subagent (type `claude`, which can edit). Give it the intent brief and:

> Run `<test command>`. If it fails, make the smallest root-cause fix to the code
> or test and re-run until it passes — the green re-run is your proof, not your
> own say-so. Apply the [fix loop discipline](#the-fix-loop-isolate-then-verify):
> **fix the cause, never weaken/delete a test or revert the change under test**, at
> most 2 attempts; if the honest fix isn't clear, stop and mark it `ask-user`. Save the
> actual command transcript (the real stdout/stderr, not a paraphrase) to
> `.ship/evidence/test.txt`. If the intent implies user-visible behavior (a CLI
> flag, an API response, a UI change), exercise it end-to-end and append that
> transcript (and any screenshot path) to the same file. Report what you ran, what
> you fixed, and any failure that's actually a deliberate-product-decision question
> (mark it `ask-user`).

Commit any fix (`ship(test): …`). No test command → say so and skip.

If the fixer flipped a previously-failing gate from red to green (by any means —
editing a test file, a fixture/golden file, the code under test, or a suppression),
a green run is not enough — verify the whole post-fix diff with a
fresh `fix-verifier` before accepting, per the
[fix loop discipline](#the-fix-loop-isolate-then-verify). The PR body sources its
testing section from `.ship/evidence/` so the evidence is the real transcript, not
subagent prose; note that this transcript may contain secrets, tokens, or absolute
paths that must be scrubbed before it is published in step 8. `.ship/` is ephemeral — ensure it's gitignored (add it if missing)
and never commit it.

### 4. Document — delegated to a fresh subagent
Spawn a subagent (type `claude`) with the diff + intent:

> Check whether this change makes any docs stale — README, `docs/`, doc comments,
> config examples, public API docs. Fix the gaps directly (docs only, no behavior
> change). Report only gaps you couldn't resolve or that need a judgment call.

Commit edits (`ship(docs): …`).

### 5. Lint — delegated to a fresh subagent
Spawn a subagent (type `claude`):

> Run `<lint/format command>`, apply safe fixes, re-run. "Safe" means formatting
> and mechanical, non-behavioral fixes (import order, gofmt, autofixable lints).
> Anything that changes behavior or silences a warning by suppression rather than
> resolution is **not** safe — leave it and report it. Report only what can't be
> auto-fixed.

Commit (`ship(lint): …`).

### 6. Rebase (orchestrator, mechanical)
If behind the default branch, `git fetch origin && git rebase origin/<base>`.
Resolve mechanical conflicts; stop and ask on judgment-call conflicts. Already
current → say so.

### 7. Push (orchestrator)
**First outward-facing action — confirm before doing it.** Show a one-line
pass summary, get the go-ahead, then `git push -u origin <branch>`. (Skip the
confirm only if the user already said to run unattended.)

### 8. PR (orchestrator)
`gh pr create` with a deterministic body: the intent brief, a short change
summary, the testing evidence **read from `.ship/evidence/`** (the real transcript,
not a paraphrase), and a one-line note for any `ask-user` finding the user accepted
as-is. Before embedding evidence in the public PR body, **scrub and summarize it**:
strip environment-variable dumps, tokens/secrets, and absolute home/user paths, and
truncate or summarize long transcripts rather than pasting them raw. Print the URL.

### 9. CI (orchestrator)
`gh pr checks <pr> --watch`. Pass → report the green PR and **stop** (leave the
merge to the user). Fail → read `gh run view --log-failed`, delegate the fix to a
fresh subagent, commit, push, re-watch. If that fix flipped a previously-failing
gate from red to green (by any means — editing a test file, a fixture/golden file,
the code under test, CI config, or a suppression), verify the whole post-fix diff
with a fresh `fix-verifier` before pushing, per the
[fix loop discipline](#the-fix-loop-isolate-then-verify) — a green CI run on a gutted
assertion is still a dishonest pass. Bound it the same way: after two failed attempts
on the same check (or the global round cap), stop and bring it to the user.

## Asking the user

For `ask-user` findings, use `AskUserQuestion`. Relay each finding as the reviewer
wrote it — `file:line` and full description, not a paraphrase. Offer: **fix it**
(and how), **leave as-is**, or **skip**. Apply the decision, then continue. Never
resolve these on your own judgment — they're the user's call by definition.

## When done

Summarize: what each fresh reviewer found, what was auto-fixed (list the fix
commits), what the user decided, and the final state (PR URL + CI status). Call
out anything fixed that the original change missed, so it's easy to review.
