# Adapter directory

Provider-specific adapters belong here (or can be passed from another path with
`--adapter`). They must be standalone Node programs that:

1. read exactly one JSON request from stdin;
2. write exactly one JSON response to stdout;
3. write diagnostics to stderr and use a non-zero exit code on failure.

No provider adapter is checked in by the core skill. Keeping the runner provider-neutral
prevents a green corpus run from being mistaken for a universal model guarantee.
