# Control-plane slice rules

## BR-CUSTOMER-001 Canonical customer identifier

The canonical contract field is `customer_id`.

## CP-G17-001 Protective behavior while live execution is unresolved

While `G-17` is open, live provider network execution is denied. A task-scoped lease may authorize only the local protected mock surface.

## CP-PERM-001 Protected customer writes

The protected customer file and local mock-network effects require `permission:customer-write` with an exact task, subject, kind, and resource match.

## CP-LEASE-001 Harness lease lifetime

The adversarial harness lease TTL is at most 30 seconds. This is an eval boundary, not a production default.

## CP-BASELINE-001 Baseline file writes

Only repository-relative file writes under `out/baseline/` are in the eval baseline. Protected network effects are never baseline-authorized.
