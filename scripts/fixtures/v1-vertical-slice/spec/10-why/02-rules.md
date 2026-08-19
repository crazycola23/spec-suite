# Authoritative rules

## BR-RETRY-001 Retry remains manual until a supported policy exists

The canonical retry-mode order is `MANUAL_ONLY`, then `DISABLED`. Automatic retry is disabled unless an authoritative rule defines the policy.
