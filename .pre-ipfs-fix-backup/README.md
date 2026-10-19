# Pre-IPFS-fix backup

`electron/package.json` and `electron/package-lock.json` as they were before
the 2026-07-25 IPFS dependency fix (see ../ipfs-experiment-report.md). This
project has no git, so this is the only restore point.

To revert: copy these two files back over `../electron/package.json` and
`../electron/package-lock.json`, then run `npm install` inside `electron/`.

Once you've reviewed the fix and are happy with it, this folder is safe to
delete (or better: `git init` the project so this kind of manual backup
stops being necessary).
