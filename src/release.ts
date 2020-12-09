import { Context } from 'probot'
import {
    fetchFile,
    semver,
    checkoutNewBranch,
    createCommitWithFileChanges,
    Changes,
    createLiveComment,
    branchExists,
} from './utils'
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
    const manifestJSONString = await fetchFile(context, 'packages/maskbook/src/manifest.json')
    const manifest: { version: string } = JSON.parse(manifestJSONString)
    const { nextMinor, nextMajor, nextPatch } = semver(manifest.version)
    const nextVersion = version === 'major' ? nextMajor : version === 'minor' ? nextMinor : nextPatch
    const releaseTitle = getReleaseTitle(version, manifest.version, nextVersion)

    const issue = context.issue()
    const repo = context.repo()
    // Add a 🚀 for the issue
    context.octokit.reactions.createForIssue({ ...issue, content: 'rocket' })
    // Rename the issue title
    context.octokit.issues.update({ ...issue, title: releaseTitle, assignees: [], labels: ['Release'] })
    // Leave a comment
    const updateComment = createLiveComment(context, `⚙ I'm preparing a new version...`)
    let lastSuccessStage = 'before checkout new branch'
    try {
        // Step 2. Create a new branch
        const newBranch = (version === 'patch' ? 'hotfix/' : 'release/') + nextVersion
        const baseBranch = version === 'patch' ? 'released' : 'master'
        if (await branchExists(context, newBranch)) {
            updateComment(
                `⚠ The branch used to release ${newBranch} already exists. I cannot create a new PR for you, sorry.`,
            )
            context.octokit.issues.update({ ...issue, state: 'closed' })
        }
        const branch = await checkoutNewBranch(context, baseBranch, newBranch)
        lastSuccessStage = 'after checkout new branch'
        // Step 3. Create a new Git tree, do some file changes in it, commit it to the new branch.
        const upgrade = versionUpgrade(manifest.version, nextVersion)
        const changes: Changes = new Map()
        changes.set('packages/maskbook/src/manifest.json', (x) => x.then(upgrade))
        await createCommitWithFileChanges(
            context,
            branch.data,
            changes,
            `chore: bump version from ${manifest.version} to ${nextVersion}`,
        )
        lastSuccessStage = 'after commit version upgrading'
        // Step 4. Open a PR for it
        const templatePath1 = '.github/RELEASE-TEMPLATE.md'
        const templatePath2 = '.github/HOTFIX-TEMPLATE.md'
        const templatePath = version === 'patch' ? templatePath2 : templatePath1
        const template = await fetchFile(context, templatePath).then(
            (x) => x.replace(/\$version/g, nextVersion),
            () =>
                `This is the release PR for ${nextVersion}. To set a default template for the release PR, create a file "${templatePath}". You can use $version to infer the new version.`,
        )
        lastSuccessStage = 'after fetch template'
        const PRTitle = `${getReleaseTitle(version, manifest.version, nextVersion)} (${version})`
        const sharedTemplate = `close #${context.payload.issue.number}

**DO NOT** push any commits to the \`released\` branch, any change on that branch will lost.
`
        if (version === 'major' || version === 'minor') {
            const pr = await context.octokit.pulls.create({
                ...repo,
                base: 'master',
                head: newBranch,
                title: PRTitle,
                body: `${sharedTemplate}
Once the release is ready, merge this branch and I'll do the rest of jobs.

${template}`,
                maintainer_can_modify: true,
            })
            lastSuccessStage = 'after PR created'
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
            const pr1 = await context.octokit.pulls.create({
                ...repo,
                base: 'released',
                head: newBranch,
                title: PRTitle + ' (1 of 2)',
                body: pr1body,
                maintainer_can_modify: true,
                draft: true,
            })
            lastSuccessStage = 'after PR 1 created'
            const pr2 = await context.octokit.pulls.create({
                ...repo,
                base: 'master',
                head: newBranch,
                title: PRTitle + ' (2 of 2)',
                body: `This is a mirror PR of ${pr1.data.html_url} to make sure that all patches to the released branch also merged into the mainline.

When the ${pr1.data.html_url} merged, I'll try to merge this automatically but there might be merge conflict.

Once there're merge conflict, you must resolve it manually.`,
            })
            lastSuccessStage = 'after PR 2 created'
            await Promise.all([
                context.octokit.pulls.update({
                    ...repo,
                    pull_number: pr1.data.number,
                    body: pr1body.replace('$link', pr2.data.html_url),
                }),
                updateComment(
                    `Hi @${context.payload.issue.user.login}! I have created [a PR for the next version ${nextVersion}](${pr1.data.html_url}) and there is [another PR to make sure patches are merged into the mainline](${pr2.data.html_url}).`,
                ),
            ])
        }
    } catch (e) {
        updateComment(`❌ ${e?.type}: ${e?.message}
${'```'}
${e?.stack}
${'```'}

@Jack-Works please fix me! The last successful stage was: ${lastSuccessStage}
`)
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
