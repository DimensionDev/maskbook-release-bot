import { Application } from 'probot'
import { release } from './release'
import {
    createLiveComment,
    semver,
    gitTagCommit,
    forcePush,
    deleteBranch,
    createComment,
    addLabel,
    LABEL_RELEASE,
} from './utils'
import { hotfix } from './hotfix'

export = ({ app }: { app: Application }) => {
    app.on('*', async (context) => {
        Object.assign(globalThis, { context })
    })
    // ? When a new issue opened with "release" "release major" or "hotfix"
    // ? Schedule a new release
    app.on('issues.opened', async (context) => {
        const { title, author_association } = context.payload.issue
        const matched = /^\[Release\]\s+(major|minor|patch)$/.exec(title)
        if (matched === null) return
        if (!isValidAction(author_association)) {
            await context.octokit.issues.update(context.issue({ state: 'closed' }))
            await createComment(
                context,
                `Hi, thanks for your interest on this project. This command is used to releasing a new version, and it is only available for the maintainers of this project.`,
            )
            await context.octokit.issues.lock(context.issue())
            return
        }
        const version = matched[1] // see line 13
        if (version === 'major' || version === 'minor' || version === 'patch') {
            await addLabel(context, context.issue(), LABEL_RELEASE)
            await release(context, version)
        }
    })
    app.on('pull_request.opened', async (context) => {
        if (context.payload.pull_request.base.ref === 'released' && !context.isBot) {
            context.octokit.pulls.update(context.pullRequest({ state: 'closed' }))
            await addLabel(context, context.issue(), LABEL_RELEASE)
            await createComment(
                context,
                'Sorry, please do not open a pull request directly to the released branch. Doing so will cause the changes lost in the next release.',
            )
        }
    })
    app.on('pull_request.closed', async (context) => {
        const pr = context.payload.pull_request
        if (!pr.merged) return
        // ? When a PR is merged, case 1: release/version merged into master
        // head = release/version, base = master
        const { head, base } = pr
        if (!(base.ref === 'master' && head.ref.startsWith('release/'))) return
        const version = semver(head.ref.replace(/^release\//, ''))
        if (!version.isValid) return
        const updateComment = createLiveComment(context, `⚡ Force pushing ${head.sha} to \`released\`...`)
        await gitTagCommit(context, head.sha, `v${version.string}`)
        await forcePush(context, head.sha, 'released')
        await deleteBranch(context, head.ref)
        await updateComment(`✔ The \`released\` has updated to ${head.sha}.\n
✔ The commit ${head.sha} is tagged as v${version.string}.\n
✔ The branch release/${version.string} is deleted.`)
    })
    app.on('pull_request', hotfix)
}

function isValidAction(author: string) {
    return ['OWNER', 'MEMBER'].includes(author)
}
