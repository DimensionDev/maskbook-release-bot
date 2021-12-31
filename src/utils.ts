import { Context } from 'probot'
import Webhooks from '@octokit/webhooks'
import type { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods/dist-types/generated/parameters-and-response-types'

export const LABEL_RELEASE = 'Release'

export async function fetchFile(context: Context<any>, path: string) {
    const res = await context.octokit.repos.getContent(context.repo({ path, mediaType: { format: 'raw' } }))
    return expectFile()
    function expectFile<T = string>() {
        if (Array.isArray(res)) throw new Error('Expect a file, but found a directory')
        return (res.data as any) as T
    }
}

export function semver(ver: string) {
    const [major, minor, patch, ...rest] = ver.split('.').map((x) => Number.parseInt(x, 10))
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
    return context.octokit.git.createRef(
        context.repo({
            ref: `refs/heads/${newName}`,
            sha: targetBranchLatestCommit.data.object.sha,
        }),
    )
}

export async function branchExists(context: Context<any>, branch: string) {
    try {
        return await queryBranchRef(context, branch)
    } catch {
        return false
    }
}

function queryBranchRef(context: Context<any>, branch: string) {
    return context.octokit.git.getRef(context.repo({ ref: `heads/${branch}` }))
}

export async function gitTagCommit(context: Context<any>, commit: string, tag: string) {
    const _tag = await context.octokit.git.createTag(
        context.repo({
            object: commit,
            tag,
            type: 'commit',
            message: tag,
        }),
    )
    return context.octokit.git.createRef(
        context.repo({
            ref: `refs/tags/${tag}`,
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
    const lastCommit = editingBranch.object.sha
    const lastTree = await context.octokit.git.getCommit(context.repo({ commit_sha: lastCommit }))

    const edits: RestEndpointMethodTypes['git']['createTree']['parameters']['tree'] = []
    for (const [path, edit] of editMap) {
        const newContent = typeof edit === 'string' ? edit : await edit(fetchFile(context, path))
        edits.push({ content: newContent, mode: '100644', path, type: 'blob' })
    }

    const newTree = await context.octokit.git.createTree(
        context.repo({
            base_tree: lastTree.data.sha,
            tree: edits,
        }),
    )
    const commit = await context.octokit.git.createCommit(
        context.repo({
            message: commitMessage,
            parents: [lastCommit],
            tree: newTree.data.sha,
        }),
    )
    await context.octokit.git.updateRef(
        context.repo({
            ref: editingBranch.ref.replace(/^refs\//, ''),
            sha: commit.data.sha,
        }),
    )
}

export function createComment(context: Context<any>, message: string) {
    return context.octokit.issues.createComment(context.issue({ body: message }))
}

export function createLiveComment(context: Context<any>, initMessage: string) {
    const { issues } = context.octokit
    return async (message: string) => {
        const { data } = await createComment(context, initMessage)
        return issues.updateComment(context.issue({ body: message, comment_id: data.id }))
    }
}

export function forcePush(context: Context<any>, pushingCommit: string, pushedBranch: string) {
    return context.octokit.git.updateRef(
        context.repo({
            ref: `heads/${pushedBranch}`,
            sha: pushingCommit,
            force: true,
        }),
    )
}

export async function merge(
    context: Context<Webhooks.EventPayloads.WebhookPayloadPullRequest>,
    pr: { mergeable: null | boolean; number: number },
    message: string,
    sha: string,
) {
    if (pr.mergeable !== true) return false
    try {
        await context.octokit.pulls.merge(
            context.pullRequest({
                number: pr.number,
                commit_title: message,
                sha,
                merge_method: 'rebase',
            }),
        )
        return true
    } catch (error) {
        if (error instanceof Error) {
            context.log(error)
        }
        return false
    }
}

export function deleteBranch(context: Context, branch: string) {
    return context.octokit.git.deleteRef(
        context.repo({
            ref: `heads/${branch}`,
        }),
    )
}

export function addLabel(context: Context, issue_number: number, name: string) {
    return context.octokit.issues.addLabels(
        context.repo({
            issue_number,
            labels: [name],
        }),
    )
}
