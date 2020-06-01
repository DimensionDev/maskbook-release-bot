## Workflows

### New release

1. Admin of the repo open a new issue, title contains `release` or `release major`
2. The bot will create a new PR for it.
3. After the PR merges, the bot will tag the commit and force push to the `released` branch.

## HotFix

1. Admin of the repo open a new issue, title contains `hotfix`
2. The bot will create 2 new PRs for it.
3. Add your fixes.
4. Mark the first PR as ready, the
