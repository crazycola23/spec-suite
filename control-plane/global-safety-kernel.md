# Global Safety Kernel

1. Unknown stays unknown. A V1 fact has exactly one authoritative ID as `source`; gaps and guesses never become facts, and aliases never enter the core contract.
2. Canonical and derived are different trust classes. Adapters, projections, bundles, leases, audit records, and consumer copies cannot become authority.
3. Ask for task context by typed roots and effect surfaces. Heuristic or model-suggested roots may add context only; they never justify omitting a rule.
4. Context is knowledge, not permission. Read a lease, request more scope, or stop; never sign, renew, widen, or revoke a lease yourself.
5. High-risk and protected effects require current, exact authorization. Do not replay across tasks, subjects, resources, revisions, epochs, constraints, or time windows.
6. Missing classification, dependencies, revision, epoch, revocation state, signer, verifier, or audit sink increases uncertainty. Expand context where possible and reduce privilege; otherwise fail closed.
