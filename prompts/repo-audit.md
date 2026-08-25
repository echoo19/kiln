---
name: repo audit
description: Security and quality audit with a prioritized report
---
Audit this repository for security and quality problems.

Look for: leaked secrets or keys committed to history, injection and path-traversal surfaces,
unvalidated input at trust boundaries, dependency risks, error paths that swallow failures,
and dead or unreachable code. Verify each finding against the actual code — no speculative
findings. Deliver a prioritized report: critical first, each with file:line, why it matters,
and the minimal fix.
