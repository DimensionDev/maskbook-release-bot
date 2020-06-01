import { Application } from 'probot'
import { release } from './release'
import { createLiveComment, semver, gitTagCommit, forcePush, merge, deleteBranch } from './utils'
import { hotfix } from './hotfix'

export = (app: Application) => {
    app.on('*', async context => {
        Object.assign(globalThis, { context })
    })
    // ? When a new issue opened with "release" "release major" or "hotfix"
    // ? Schedule a new release
    app.on('issues.opened', async context => {
        if (isValidAction(context.payload.issue.author_association)) {
            const title = context.payload.issue.title.toLowerCase()
            if (title.includes('release major')) await release(context, 'major')
            else if (title.includes('release')) await release(context, 'minor')
            else if (title.includes('hotfix')) await release(context, 'patch')
        }
    })
    app.on('pull_request.closed', async context => {
        const pr = context.payload.pull_request
        if (!pr.merged) return
        // ? When a PR is merged, case 1: release/version merged into master
        // head = release/version, base = master
        const { head, base } = pr
        if (base.ref === 'master' && head.ref.startsWith('release/')) {
            const version = semver(head.ref.replace('release/', ''))
            if (!version.isValid) return
            const updateComment = createLiveComment(context, `⚡ Force pushing ${head.sha} to \`released\`...`)
            await gitTagCommit(context, head.sha, `v${version.string}`)
            await forcePush(context, head.sha, 'released')
            deleteBranch(context, head.ref)
            updateComment(`✔ The \`released\` has updated to ${head.sha}.\n
✔ The commit ${head.sha} is tagged as v${version.string}.\n
✔ The branch release/${version.string} is deleted.`)
        }
    })
    app.on('pull_request', async context => {
        await hotfix(context)
    })
}

function isValidAction(author: string) {
    if (author === 'COLLABORATOR' || author === 'OWNER' || author === 'MEMBER') return true
    return false
}
