import { Context } from 'probot'
import { semver, createLiveComment, gitTagCommit, merge, deleteBranch, forcePush } from './utils'
import * as Webhooks from '@octokit/webhooks'

export async function hotfix(context: Context<Webhooks.EventPayloads.WebhookPayloadPullRequest>) {
    const pr = context.payload.pull_request
    if (context.payload.action !== 'ready_for_review') return
    // ? When a PR is ready for review, case 2: hotfix/version merged into released
    const { head, base } = pr
    if (base.ref === 'released' && head.ref.startsWith('hotfix/')) {
        const ccList = new Set()
        ccList.add(context.payload.sender.login)
        pr.assignees.forEach((x) => ccList.add(x.login))
        const cc = `\n\n(CC: ${[...ccList].map((x) => '@' + x).join(' ')})`

        const version = semver(head.ref.replace('hotfix/', ''))
        if (!version.isValid) return
        const updateComment = createLiveComment(context, `⚡ This PR is marked as ready. Preparing hotfix...`)
        await gitTagCommit(context, head.sha, `v${version.string}`)
        await forcePush(context, head.sha, 'released')

        const relatedPR = await context.octokit.pulls
            .list({
                ...context.repo(),
                state: 'open',
                head: `hotfix/${version}`,
                base: 'master',
            })
            .then((x) => x.data.filter((x) => x.title.includes(`2 of 2`))[0])
            .then((x) => context.octokit.pulls.get({ ...context.repo(), number: x.number }))
            .then((x) => x.data)

        if (!relatedPR) {
            const title2 = pr.title.replace('1 of 2', '2 of 2')
            return updateComment(`✔ This PR is automatically merged.\n
⚠ I can't find the related PR for this PR so I can't merge it for you. It should titled as "${title2}"${cc}`)
        }

        const autoMerge = await merge(context, relatedPR, `chore: merge ${version.string} into master`, head.sha)
        relatedPR.number
        if (autoMerge) {
            await deleteBranch(context, head.ref)
            return updateComment(`✔ This PR is automatically merged.\n
✔ [The related PR](${relatedPR.html_url}) is automatically merged too.

🎉 Don't forget to upload them to the store!${cc}`)
        }
        return updateComment(`✔ This PR is automatically merged.\n
⚠ I can't automatically merge [the related PR](${relatedPR.html_url}). You should do it by your self.${cc}`)
    }
    return
}
