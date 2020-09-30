import { Context } from 'probot'
import Webhooks from '@octokit/webhooks'
import type { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods/dist-types/generated/parameters-and-response-types'
export async function fetchFile(context: Context<any>, path: string) {
    const res = await context.github.repos.getContents(context.repo({ path, mediaType: { format: 'raw' } }))
    return expectFile()
    function expectFile<T = string>() {
        if (Array.isArray(res)) throw new Error('Expect a file, but found a directory')
        return (res.data as any) as T
    }
}

export function semver(ver: string) {
    const [major, minor, patch, ...rest] = ver.split('.').map((x) => parseInt(x, 10))
    let isValid = true
    if (rest.length) isValid = false
    if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) isValid = false
    return {
        isValid,
        string: `${major}.${minor}.${patch}`,
        major,
        minor,
        patch,
        nextMajor: `${major + 1}.0.0`,
        nextMinor: `${major}.${minor + 1}.0`,
        nextPatch: `${major}.${minor}.${patch + 1}`,
    }
}

export async function checkoutNewBranch(context: Context<any>, targetBranch: string, newName: string) {
    const targetBranchLatestCommit = await queryBranchRef(context, targetBranch)
    return context.github.git.createRef({
        ...context.repo(),
        ref: 'refs/heads/' + newName,
        sha: targetBranchLatestCommit.data.object.sha,
    })
}
function queryBranchRef(context: Context<any>, branch: string) {
    return context.github.git.getRef({ ...context.repo(), ref: 'heads/' + branch })
}
export async function gitTagCommit(context: Context<any>, commit: string, tag: string) {
    const repo = context.repo()
    const _tag = await context.github.git.createTag({
        ...repo,
        object: commit,
        tag,
        type: 'commit',
        message: tag,
    })
    return context.github.git.createRef(
        context.repo({
            ref: 'refs/tags/' + tag,
            sha: _tag.data.object.sha,
        }),
    )
}

export type Changes = Map<string, string | ((file: Promise<string>) => Promise<string>)>
export async function createCommitWithFileChanges(
    context: Context<any>,
    editingBranch: RestEndpointMethodTypes['git']['createRef']['response']['data'],
    editMap: Changes,
    commitMessage: string,
) {
    const repo = context.repo()
    const lastCommit = editingBranch.object.sha
    const lastTree = await context.github.git.getCommit({ ...repo, commit_sha: lastCommit })

    const edits: RestEndpointMethodTypes['git']['createTree']['parameters']['tree'] = []
    for (const [path, edit] of editMap) {
        const newContent = typeof edit === 'string' ? edit : await edit(fetchFile(context, path))
        edits.push({ content: newContent, mode: '100644', path, type: 'blob' })
    }

    const newTree = await context.github.git.createTree({
        ...repo,
        base_tree: lastTree.data.sha,
        tree: edits,
    })
    const commit = await context.github.git.createCommit({
        ...repo,
        message: commitMessage,
        parents: [lastCommit],
        tree: newTree.data.sha,
    })
    await context.github.git.updateRef({
        ...repo,
        ref: editingBranch.ref.replace('refs/', ''),
        sha: commit.data.sha,
    })
}
export function createLiveComment(context: Context<any>, initMessage: string) {
    const issue = context.issue()
    const pending = context.github.issues.createComment({ ...issue, body: initMessage })
    return async (message: string) => {
        return context.github.issues.updateComment({ ...issue, body: message, comment_id: (await pending).data.id })
    }
}

export function forcePush(context: Context<any>, pushingCommit: string, pushedBranch: string) {
    return context.github.git.updateRef({
        ...context.repo(),
        ref: 'heads/' + pushedBranch,
        sha: pushingCommit,
        force: true,
    })
}
export async function merge(
    context: Context<Webhooks.EventPayloads.WebhookPayloadPullRequest>,
    pr: { mergeable: null | boolean; number: number },
    message: string,
    sha: string,
) {
    if (pr.mergeable !== true) return false
    try {
        await context.github.pulls.merge({
            ...context.issue(),
            number: pr.number,
            commit_title: message,
            sha,
            merge_method: 'rebase',
        })
        return true
    } catch (e) {
        context.log(e)
        return false
    }
}
export function deleteBranch(context: Context, branch: string) {
    return context.github.git.deleteRef({ ...context.repo(), ref: 'heads/' + branch })
}
