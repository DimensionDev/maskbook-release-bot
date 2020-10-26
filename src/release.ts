import { Context } from 'probot'
import { fetchFile, semver, checkoutNewBranch, createCommitWithFileChanges, Changes, createLiveComment } from './utils'
import Webhooks from '@octokit/webhooks'
type Semver = 'major' | 'minor' | 'patch'

/**
 * Workflow:
 *
 * Release:
 *      Create a new branch, create PR to master, wait for merge.
 *      Once merged, tag the latest commit and force push to the `released` branch.
 *
 * HotFix:
 *      Create a new branch, create PR to master, create PR to released.
 *      Once (PR to released) draft => ready, tag the latest commit and merge it automatically.
 */
export async function release(context: Context<Webhooks.EventPayloads.WebhookPayloadIssues>, version: Semver) {
    // Step 1. Get the latest version on the GitHub.
    const packageJSONString = await fetchFile(context, 'package.json')
    const packageJSON: { version: string } = JSON.parse(packageJSONString)
    const { nextMinor, nextMajor, nextPatch } = semver(packageJSON.version)
    const nextVersion = version === 'major' ? nextMajor : version === 'minor' ? nextMinor : nextPatch
    const releaseTitle = getReleaseTitle(version, packageJSON.version, nextVersion)

    const issue = context.issue()
    const repo = context.repo()
    // Add a 🚀 for the issue
    context.github.reactions.createForIssue({ ...issue, content: 'rocket' })
    // Rename the issue title
    context.github.issues.update({ ...issue, title: releaseTitle, assignees: [] })
    // Leave a comment
    const updateComment = createLiveComment(context, `⚙Handling... Please wait a second`)
    // Step 2. Create a new branch
    const newBranch = (version === 'patch' ? 'hotfix/' : 'release/') + nextVersion
    const baseBranch = version === 'patch' ? 'released' : 'master'
    const branch = await checkoutNewBranch(context, baseBranch, newBranch)
    // Step 3. Create a new Git tree, do some file changes in it, commit it to the new branch.
    const upgrade = versionUpgrade(packageJSON.version, nextVersion)
    const changes: Changes = new Map()
    changes.set('package.json', upgrade(packageJSONString))
    changes.set('packages/maskbook/src/manifest.json', (x) => x.then(upgrade))
    await createCommitWithFileChanges(
        context,
        branch.data,
        changes,
        `chore: bump version from ${packageJSON.version} to ${nextVersion}`,
    )
    // Step 4. Open a PR for it
    const templatePath1 = '.github/RELEASE-TEMPLATE.md'
    const templatePath2 = '.github/HOTFIX-TEMPLATE.md'
    const templatePath = version === 'patch' ? templatePath2 : templatePath1
    const template = await fetchFile(context, templatePath).then(
        (x) => x.replace(/\$version/g, nextVersion),
        () =>
            `This is the release PR for ${nextVersion}. To set a default template for the release PR, create a file "${templatePath}". You can use $version to infer the new version.`,
    )
    const PRTitle = `${getReleaseTitle(version, packageJSON.version, nextVersion)} (${version})`
    const sharedTemplate = `close #${context.payload.issue.number}

**DO NOT** push any commits to the \`released\` branch, any change on that branch will lost.
`
    if (version === 'major' || version === 'minor') {
        const pr = await context.github.pulls.create({
            ...repo,
            base: 'master',
            head: newBranch,
            title: PRTitle,
            body: `${sharedTemplate}
Once the release is ready, merge this branch and I'll do the rest of jobs.

${template}`,
            maintainer_can_modify: true,
        })
        await updateComment(
            `Hi @${context.payload.issue.user.login}! I have created [a PR for the next version ${nextVersion}](${pr.data.html_url}). Please test it, feel free to add new patches.`,
        )
    } else if (version === 'patch') {
        const pr1body = `${sharedTemplate}
Once the hotfix is ready, convert this PR from **draft** to **ready**.

Then, I'll tag the latest commit with "v${nextVersion}" and merge this automatically.

There is [another PR]($link) point to the master branch to make sure patches are in  the mainline.

${template}`
        // Create 2 PR. hotfix/version => released, hotfix/version => master
        const pr1 = await context.github.pulls.create({
            ...repo,
            base: 'released',
            head: newBranch,
            title: PRTitle + ' (1 of 2)',
            body: pr1body,
            maintainer_can_modify: true,
            draft: true,
        })
        const pr2 = await context.github.pulls.create({
            ...repo,
            base: 'master',
            head: newBranch,
            title: PRTitle + ' (2 of 2)',
            body: `This is a mirror PR of ${pr1.data.html_url} to make sure that all patches to the released branch also merged into the mainline.

When the ${pr1.data.html_url} merged, I'll try to merge this automatically but there might be merge conflict.

Once there're merge conflict, you must resolve it manually.`,
        })
        await Promise.all([
            context.github.pulls.update({
                ...repo,
                pull_number: pr1.data.number,
                body: pr1body.replace('$link', pr2.data.html_url),
            }),
            updateComment(
                `Hi @${context.payload.issue.user.login}! I have created [a PR for the next version ${nextVersion}](${pr1.data.html_url}) and there is [another PR to make sure patches are merged into the mainline](${pr2.data.html_url}).`,
            ),
        ])
    }
}

function getReleaseTitle(version: Semver, currentVersion: string, nextVersion: string) {
    switch (version) {
        case 'major':
        case 'minor':
            return `[Release] New release ${nextVersion}`
        case 'patch':
            return `[Release] Hotfix ${currentVersion} => ${nextVersion}`
    }
}
function versionUpgrade(old: string, newV: string) {
    return (x: string) => x.replace(`"version": "${old}"`, `"version": "${newV}"`)
}
