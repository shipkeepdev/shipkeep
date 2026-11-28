import type { GithubApi } from '../modules/git/application/ports';

const unexpected = (): Promise<never> =>
  Promise.reject(new Error('This test does not expect a write to GitHub.'));

/**
 * The GitHub calls of a configuration change (#214), for a test double of a suite that makes
 * none: a read finds no file, and a write fails the test.
 */
export const noGithubWrites: Pick<
  GithubApi,
  | 'fileAt'
  | 'createBranch'
  | 'writeFile'
  | 'openPullRequest'
  | 'commitMessage'
  | 'openPullRequestFrom'
> = {
  fileAt: () => Promise.resolve(undefined),
  createBranch: unexpected,
  writeFile: unexpected,
  openPullRequest: unexpected,
  commitMessage: unexpected,
  openPullRequestFrom: unexpected,
};
