---
name: spec-suite
description: >-
  Use when creating or auditing a machine-checkable specification suite for
  multiple agents, multiple repositories, shared contracts, or high-risk facts
  such as money, permissions, and irreversible operations; also use in
  repositories that already adopt spec-suite. Do not bootstrap the full suite
  for an ordinary isolated code change or a single design document; persist the
  unsupported fact with the lightweight unresolved protocol instead.
compatibility: >-
  Core workflows require Node.js 22+. Control-plane isolation additionally
  requires POSIX process identities and filesystem capabilities.
---

# Spec Suite

Build a control plane in which unknown facts stay unknown, canonical facts have resolvable authority, and every derived artifact is reproducible.

## 1. Select the mode

Use **full mode** when any condition is true:

- the project already adopts spec-suite;
- one contract is shared by multiple agents or repositories;
- the fact controls money, permissions, external side effects, or another hard-to-reverse action;
- the user explicitly asks for specification or contract governance.

Otherwise use **lightweight mode**. Do not add the full directory structure just because one retry count, threshold, enum, or price lacks evidence.

For an unfamiliar repository, run the read-only adoption assessment before creating any
files:

```bash
node scripts/adopt.mjs --repo-root . --dry-run
node scripts/adopt.mjs --repo-root . --format json --no-input
```

The assessment observes existing artifacts, asks only about facts the repository cannot
prove, and returns `no-op`, `lightweight`, `full`, or `needs-input`. It never creates or
edits adoption files in this version.

### Lightweight mode

1. Stop before turning the unknown into a default.
2. Search existing authoritative sources.
3. Ask the owner when possible.
4. Persist the fact in `.spec-suite/unresolved.yaml`; `sourceSearch` records search actions, not proof that no source exists.
5. Guard repeated work with `guard-unresolved-fact.mjs`. Exit code 3 means the action remains blocked.
6. If the project later adopts full mode, migrate the same fact once with `migrate-unresolved.mjs`; preserve provenance and reuse the same `G-*` on repeated migration.

### Trigger evaluation

Skill discovery and mode routing are evaluated separately. The corpus and adapter protocol
live under `evals/trigger/`:

```bash
node scripts/eval-trigger.mjs --validate
node scripts/eval-trigger.mjs --adapter <node-adapter>
```

Discovery receives only `name + description`; routing receives the full `SKILL.md`. A
critical mismatch fails the eval, while exploratory cases are reported without inventing
an accuracy threshold.

Template: `templates/lightweight/unresolved.yaml`.

## 2. Full-mode invariants

1. **Unknown stays unknown.** Only facts supported by a resolvable authoritative source enter canonical contracts. A choice that is still open remains unresolved. Lightweight unresolved may upgrade to one `G-*`; it never becomes a second registry.
2. **Canonical stays canonical.** Handwritten rules and canonical YAML are sources. Agent adapters, Markdown generated regions, bundles, manifests, reports, and consumer copies are derived and never become sources.
3. **Derived stays reproducible.** The same canonical inputs produce identical adapter regions, bundle bytes, manifest, and consumer verification result.

The following transitions are invalid and must fail:

```text
unknown          -> invented canonical fact
broken canonical -> successful generation
derived artifact -> authoritative source
```

## 3. Scope level

Start at L0 and add only the layer whose trigger exists.

| Level | Add | Trigger |
|---|---|---|
| L0 | canonical entry, declared platform adapters, dictionary, gaps, checker, bundle generator, CI | any full-mode condition |
| L1 | conventions, errors, permissions, decision sheets, consumer stubs | money, permissions, third-party nondeterminism, or product decisions |
| L2 | screens, modals, traceability, delivery slices | frontend/backend parallel delivery |
| L3 | progress ledger, provider baseline, legacy deprecation | long-running or legacy migration work |

Contract scaffolds are independent of level. Route to `templates/contracts/` only when workflow E begins. Do not create empty future-level files.

## 4. Workflow A–F

```text
A  Extract evidence and unresolved facts       -> INTERVIEW.md
B  Freeze only source-backed dictionary facts  -> unresolved choices stay unresolved
C  Render canonical agent entry into declared platform adapters + install checker/fixer + CI
D  Close only decisions that block the next irreversible boundary
E  Add DDL/API fixtures and generate the neutral bundle
F  Add L2 screens/traceability/slices when triggered
```

At every phase end, identify every new enum, transition, threshold, formula, amount, retry count, ratio, permission boundary, provider, quantity, timeout, unit, and SLA. Each must resolve to an authoritative ID or remain unresolved. There is no “reasonable default” state.

## 5. V1 execution surface

The commands have deliberately separate verbs:

```bash
# Read persistent lightweight state; exit 3 means unresolved.
node scripts/guard-unresolved-fact.mjs --specs-root . --fact <stable_fact_name>

# One-way, idempotent lightweight unresolved -> G-* migration.
node scripts/migrate-unresolved.mjs --specs-root . --fact <name> \
  --block <path-or-id> --protective-default <behavior> \
  --rollback-cost <cost> --owner <owner>

# Validate only.
node scripts/check-spec-suite.mjs --specs-root . --config spec-suite.config.json

# Rewrite only Markdown adapter/projection regions.
node scripts/check-spec-suite.mjs --specs-root . --config spec-suite.config.json \
  --write-generated-regions

# Generate only the language-neutral bundle and manifest.
node scripts/generate-contract-bundle.mjs --specs-root . --config spec-suite.config.json

# Verify a checked-in consumer copy by manifest, file set, and bytes.
node scripts/verify-consumer-contracts.mjs --specs-root . \
  --config spec-suite.config.json --consumer-root <consumer-contract-directory>
```

The generator is fail-closed. It validates all canonical inputs and source references before writing; a failure leaves the prior bundle untouched. V1 generates `contract-bundle.json` plus `manifest.json`. It does not define `specHash`, SemVer compatibility, deprecation windows, or breaking-change policy; those are V2 concerns after the deterministic boundary is stable.

### Multi-Agent execution surface

When several Agents work in parallel, each task SHOULD declare `baseRevision`,
`readSet`, and `writeSet`; `readSet` and `writeSet` MUST appear together. Give each
Agent one identity and one worktree/branch. Treat `baseRevision` as a frozen observation:
if the integration target advances, the result is stale until it is rebased and checked
again, even when the changed files look disjoint.

Run `node scripts/merge-gate.mjs` before integration. It MUST reject actual changes
outside `writeSet`, same-file changes made on the target since `baseRevision`, and any
task that omits the concurrency contract. `role` is descriptive identity metadata; it
does not replace policy-owned authorization. The gate is read-only: it reports whether a
fast-path merge is safe and never performs the merge or rebase itself.

## 6. Router

- Evidence extraction, source qualification, unresolved vs decision → [INTERVIEW.md](INTERVIEW.md)
- Canonical Agent Entry Contract, generated common region, platform-specific adapter region, bans → [DISCIPLINES.md](DISCIPLINES.md)
- YAML shapes, markers, config, bundle/manifest, checker and audit → [SCHEMA.md](SCHEMA.md)
- Minimal full-mode scaffold and proven example → `templates/L0/`
- Errors, permissions, conventions, decisions, consumer stubs → `templates/L1/`
- Screens, modals, traceability, delivery slices → `templates/L2/`
- Progress, provider baseline, legacy retirement → `templates/L3/`
- OpenAPI, DDL, fixtures → `templates/contracts/`
- Lightweight-only persistence → `templates/lightweight/`
- Executable tools and tests → `scripts/`

For an audit, first write a config matching the target repository’s namespaces and paths, then run the checker read-only with `--report` pointing outside the target. A fallback example config is not evidence about the audited repository.

## 7. Stop conditions

Stop the dependent action and surface the unresolved state when:

- a fact has no resolvable authoritative source;
- a proposed value depends on an unclosed product choice;
- canonical input is missing or cannot be parsed;
- a source resolves only to `G-*`, `mayLackDefinition`, or `generated/`;
- generation or consumer verification fails.

Unrelated reversible work may continue. Do not claim the blocked contract, adapter, bundle, or consumer copy is current.

## 8. Normative language

- **MUST / MUST NOT** in this skill and its routed references are executable requirements.
- **Heuristic** marks a default judgment that may be overridden with project evidence.
- **Observed result** describes a specific prior project, not a universal law.
