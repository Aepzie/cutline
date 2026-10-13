# Changesets

Add a changeset for every user-facing change:

```bash
pnpm changeset
```

All `@cutline/*` packages are versioned together.

## Cutting a release

1. On a `chore/release-x.y.z` branch run `GITHUB_TOKEN=$(gh auth token) pnpm version-packages`
   (bumps versions, writes package changelogs) and add a matching `## [x.y.z]` section to the
   root `CHANGELOG.md`. Open a PR and merge it.
2. Tag the merge commit and push the tag: `git tag -a vx.y.z -m "Cutline vx.y.z" && git push origin vx.y.z`.
3. The Release workflow creates the GitHub Release from the `CHANGELOG.md` section.
