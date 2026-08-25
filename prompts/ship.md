---
name: ship
description: Stage, commit, and push current work with verification
---
Ship the current working-tree changes.

1. Review the diff and group it into one or more coherent commits with clear messages.
2. Run the project's tests or build if one exists; do not ship on red.
3. Commit and push to the current branch. Environment credentials are already loaded — never echo them.
4. Report: commits created, test results, and anything you deliberately left unshipped.
