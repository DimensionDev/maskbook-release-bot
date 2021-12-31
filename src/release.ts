import { Context } from 'probot'
import {
    fetchFile,
    semver,
    checkoutNewBranch,
    createCommitWithFileChanges,
    Changes,
    createLiveComment,
    branchExists,
    deleteBranch,
    createComment,
    addLabel,
    LABEL_RELEASE,
} from './utils'
import Webhooks from '@octokit/webhooks'
type Semver = 'major' | 'minor' | 'patch'

enum Status {
    BeforeGetLatestVersion,
    BeforeCheckIfNewBranchAlreadyExists,
    BeforeCheckoutNewBranch,
    BeforeBumpVersion,
    CreatePR,
}
type ReportFunction = {
    (progress: Exclude<Status, Status.CreatePR>): Promise<void>
    (progress: Status.CreatePR, count: number, all: number): Promise<void>
}

export async function release(context: Context<Webhooks.EventPayloads.WebhookPayloadIssues>, expectedSemver: Semver) {
    const updateComment = createLiveComment(context, `⚙ Working...`)
    let lastMessage = '⚙ Working...'
    let lastStatus: Status = -1
    let lastCount = 0
    let lastAll = 1
    let lastComposedMessage = createMessage(lastStatus, lastCount, lastAll, lastMessage)
    let lastPromise: Promise<any> = Promise.resolve()
    const interval = setInterval(() => {
        const currentMessage = createMessage(lastStatus, lastCount, lastAll, lastMessage)
        if (lastComposedMessage !== currentMessage) {
            lastComposedMessage = currentMessage
            lastPromise = updateComment(currentMessage)
        }
    }, 1000)
    try {
        await release_with_report(
            context,
            expectedSemver,
            (async (progress: Status, count: number, all: number) => {
                lastStatus = progress
                lastCount = count
                lastAll = all
                return lastPromise
            }) as ReportFunction,
            async (message) => {
                lastMessage = message
                return lastPromise
            },
        )
    } catch (error) {
        if (error instanceof Error) {
            lastMessage = `❌ ${error.constructor.name || 'Error'}: ${error.message}
${'```'}
${error.stack}
${'```'}

@Jack-Works please fix me!`
        }
    } finally {
        clearInterval(interval)
        await updateComment(createMessage(lastStatus, lastCount, lastAll, lastMessage))
    }
}

function createMessage(progress: Status, count: number, all: number, message: string) {
    let text = ''
    ord(Status.BeforeGetLatestVersion, 'Get latest version')
    ord(Status.BeforeCheckIfNewBranchAlreadyExists, 'Check if the target branch exists')
    ord(Status.BeforeCheckoutNewBranch, 'Check out to the target branch')
    ord(Status.BeforeBumpVersion, 'Bump version')
    if (Status.CreatePR === progress) {
        if (count === all) text += `- ✅ PR created\n`
        else text += `- ⏳ Creating PR... ${all > 1 ? `(${count} of ${all})` : ''}\n`
    } else text += `- Create PR\n`
    function ord(x: Status, y: string) {
        if (progress < x) text += `- ${y}...\n`
        else if (progress === x) text += `- ⏳ ${y}\n`
        else text += `- ✅ ${y}\n`
    }
    return text + '\n\n' + message
}

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
export async function release_with_report(
    context: Context<Webhooks.EventPayloads.WebhookPayloadIssues>,
    expectedSemver: Semver,
    reportProgress: ReportFunction,
    reportMessage: (message: string) => Promise<void>,
) {
    //#region Step 0. Get the latest version on the GitHub.
    reportProgress(Status.BeforeGetLatestVersion)
    const { releaseTitle, nextVersion, currentVersion } = await (async () => {
        const manifestJSONString = await fetchFile(context, 'packages/maskbook/src/manifest.json')
        const { version: currentVersion }: { version: string } = JSON.parse(manifestJSONString)
        const { nextMinor, nextMajor, nextPatch } = semver(currentVersion)
        const nextVersion = expectedSemver === 'major' ? nextMajor : expectedSemver === 'minor' ? nextMinor : nextPatch
        const releaseTitle = getReleaseTitle(expectedSemver, currentVersion, nextVersion)
        return { releaseTitle, nextVersion, currentVersion }
    })()
    // Add a 🚀 for the issue
    context.octokit.reactions.createForIssue(context.issue({ content: 'rocket' }))
    // Rename the issue title
    context.octokit.issues.update(context.issue({ title: releaseTitle, assignees: [], labels: [LABEL_RELEASE] }))
    //#endregion

    //#region Step 1. Fetch PR template
    const templatePath = expectedSemver === 'patch' ? '.github/HOTFIX-TEMPLATE.md' : '.github/RELEASE-TEMPLATE.md'
    const sharedTemplate = getSharedPRTemplate(context.payload.issue.number)
    const template = fetchFile(context, templatePath).then(
        (x) => x.replace(/\$version/g, nextVersion),
        () => getDefaultPRTemplate(nextVersion, templatePath),
    )
    //#endregion

    //#region Step 2. Check if the branch exists
    reportProgress(Status.BeforeCheckIfNewBranchAlreadyExists)
    const baseBranch = expectedSemver === 'patch' ? 'released' : 'master'
    const newBranch = (expectedSemver === 'patch' ? 'hotfix/' : 'release/') + nextVersion
    const ifExisting = await branchExists(context, newBranch)
    if (ifExisting) {
        createComment(
            context,
            `The branch ${newBranch} already exists, I removed it to continue. FYI that branch was on commit ${ifExisting.data.object.sha}`,
        )
        await deleteBranch(context, newBranch)
    }
    //#endregion

    //#region Step.3 Checkout new branch
    {
        reportProgress(Status.BeforeCheckoutNewBranch)
        const newBranchInfo = await checkoutNewBranch(context, baseBranch, newBranch)
        //#endregion

        //#region Step 4. Create a new Git tree, do some file changes in it, commit it to the new branch.
        reportProgress(Status.BeforeBumpVersion)
        const upgrade = versionUpgrade(currentVersion, nextVersion)
        const changes: Changes = new Map()
        changes.set('packages/maskbook/src/manifest.json', (x) => x.then(upgrade))
        await createCommitWithFileChanges(
            context,
            newBranchInfo.data,
            changes,
            `chore: bump version from ${currentVersion} to ${nextVersion}`,
        )
    }
    //#endregion

    const PRTitle = getReleaseTitle(expectedSemver, currentVersion, nextVersion)
    if (expectedSemver === 'major' || expectedSemver === 'minor') {
        //#region Step 6.a Create Release PR
        reportProgress(Status.CreatePR, 0, 1)
        const pr = await context.octokit.pulls.create(
            context.repo({
                base: 'master',
                head: newBranch,
                title: PRTitle,
                body: getReleasePRTemplate(sharedTemplate, await template),
                maintainer_can_modify: true,
            }),
        )
        await addLabel(context, pr.data.number, LABEL_RELEASE)
        reportProgress(Status.CreatePR, 1, 1)
        await reportMessage(
            `Hi @${context.payload.issue.user.login}! I have created [a PR for the next version ${nextVersion}](${pr.data.html_url}). Please test it, feel free to add new patches.`,
        )
        //#endregion
    } else if (expectedSemver === 'patch') {
        //#region Step 6.b Create hotfix PR
        const pr1body = getHotfixPR1Template(sharedTemplate, nextVersion, await template)
        reportProgress(Status.CreatePR, 0, 2)
        const pr1 = await context.octokit.pulls.create(
            context.repo({
                base: 'released',
                head: newBranch,
                title: PRTitle + ' (1 of 2)',
                body: pr1body,
                maintainer_can_modify: true,
                draft: true,
            }),
        )
        await addLabel(context, pr1.data.number, LABEL_RELEASE)
        reportProgress(Status.CreatePR, 1, 2)
        const pr2 = await context.octokit.pulls.create(
            context.repo({
                base: 'master',
                head: newBranch,
                title: PRTitle + ' (2 of 2)',
                body: getHotfixPR2Template(pr1.data.html_url),
            }),
        )
        await addLabel(context, pr2.data.number, LABEL_RELEASE)
        reportProgress(Status.CreatePR, 2, 2)

        const updatePR1 = context.octokit.pulls.update(
            context.repo({
                pull_number: pr1.data.number,
                body: pr1body.replace('$link', pr2.data.html_url),
            }),
        )
        const conclusion = reportMessage(
            `Hi @${context.payload.issue.user.login}! I have created [a PR for the next version ${nextVersion}](${pr1.data.html_url}) and there is [another PR to make sure patches are merged into the mainline](${pr2.data.html_url}).`,
        )
        await updatePR1
        await conclusion
        //#endregion
    }
}

function getHotfixPR1Template(sharedTemplate: string, nextVersion: string, template: string) {
    return `${sharedTemplate}
Once the hotfix is ready, convert this PR from **draft** to **ready**.

Then, I'll tag the latest commit with "v${nextVersion}" and merge this automatically.

There is [another PR]($link) point to the master branch to make sure patches are in  the mainline.

${template}`
}

function getHotfixPR2Template(url: string): string {
    return `This is a mirror PR of ${url} to make sure that all patches to the released branch also merged into the mainline.

When the ${url} merged, I'll try to merge this automatically but there might be merge conflict.

Once there're merge conflict, you must resolve it manually.`
}

function getReleasePRTemplate(sharedTemplate: string, template: string): string {
    return `${sharedTemplate}
Once the release is ready, merge this branch and I'll do the rest of jobs.

${template}`
}

function getSharedPRTemplate(context: number) {
    return `close #${context}

**DO NOT** push any commits to the \`released\` branch, any change on that branch will lost.
`
}

function getDefaultPRTemplate(nextVersion: string, templatePath: string): string | PromiseLike<string> {
    return `This is the release PR for ${nextVersion}. To set a default template for the release PR, create a file "${templatePath}". You can use $version to infer the new version.`
}

function getReleaseTitle(version: Semver, currentVersion: string, nextVersion: string) {
    switch (version) {
        case 'major':
        case 'minor':
            return `[Release] New release ${nextVersion} (${version})`
        case 'patch':
            return `[Release] Hotfix ${currentVersion} => ${nextVersion} (${version})`
    }
}
function versionUpgrade(old: string, newV: string) {
    return (x: string) => x.replace(`"version": "${old}"`, `"version": "${newV}"`)
}
