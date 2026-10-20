# Release process

This action has no runtime dependencies or build output. The checked-in `main.js` is the action runtime file.

1. Run `node --version` and confirm major version 24, then run `node --check main.js` and `npm test`.
2. Review the release diff, including `action.yml`, `main.js`, tests, README, workflow examples, CI and `LICENSE`. Confirm no private notes or credentials are present.
3. Publish to `flowxo/greatwait-action` through the repository's normal workflow. Verify the remote commit and green CI checks.
4. Create a `vX.Y.Z` version tag at that exact tested commit and a GitHub release with concise release notes. Verify the tag and release resolve to that commit.
5. Handle any GitHub Marketplace listing and explicit agreement separately after inspecting its terms. A repository release does not require a Marketplace listing.

No live GreatWait call is part of this process. A later controlled smoke test requires a pre-existing endpoint, scoped credential and separate operational authorization.
