import SemanticReleaseError from '@semantic-release/error';
import { Agent, RetryAgent, fetch, type Dispatcher } from 'undici';
import { messageOf } from './utils/error.js';
import { isRecord, stringAt } from './utils/object.js';

const API_ROOT = 'https://api.github.com';

/**
 * Create the dispatcher the client uses by default. Every request made through
 * it is a GET, which is safe to repeat, so throttling (429), server errors
 * (500, 502, 503, 504) and dropped connections are retried with exponential
 * backoff, honouring `Retry-After`. Each attempt is bounded by connect, header
 * and body timeouts.
 *
 * @param base The dispatcher to wrap; a plain agent with timeouts by default.
 * @returns A dispatcher that retries idempotent requests.
 */
export function createDispatcher(
  base: Dispatcher = new Agent({
    connect: { timeout: 10_000 },
    headersTimeout: 30_000,
    bodyTimeout: 30_000,
  }),
): Dispatcher {
  return new RetryAgent(base, {
    maxRetries: 3,
    minTimeout: 500,
    maxTimeout: 10_000,
    timeoutFactor: 2,
    methods: ['GET'],
  });
}

/**
 * Read the tag names out of an untrusted releases response.
 *
 * @param payload Parsed JSON from the releases endpoint.
 * @returns The tag name of every release, or undefined when the payload is not
 * an array of objects that all have a string `tag_name`.
 */
function parseReleaseTags(payload: unknown): readonly string[] | undefined {
  if (!Array.isArray(payload)) {
    return undefined;
  }
  const tags = payload.map((item: unknown) =>
    isRecord(item) ? stringAt(item, 'tag_name') : undefined,
  );
  return tags.every((tag): tag is string => tag !== undefined)
    ? tags
    : undefined;
}

/**
 * Explain a failed releases request.
 *
 * @param repo The repository, as `owner/repo`.
 * @param status HTTP status of the response.
 * @param statusText HTTP status text of the response.
 * @param hasToken Whether the request was authenticated.
 * @returns The message of the error to throw.
 */
function describeFailure(
  repo: string,
  status: number,
  statusText: string,
  hasToken: boolean,
): string {
  const prefix = `Failed to fetch releases from ${repo} (${status} ${statusText}).`;
  switch (status) {
    case 404:
      return hasToken
        ? `${prefix} Repository not found, or the provided GitHub token does not have 'repo' scope access to it.`
        : `${prefix} The repository was not found or it is private. For private repositories, please provide a GitHub token with 'repo' scope.`;
    case 401:
      return `${prefix} Authentication failed. The provided GitHub token is likely invalid, expired, or does not have the 'repo' scope.`;
    case 403:
      return `${prefix} Access forbidden. The provided GitHub token might lack required scopes (e.g., 'repo'), or an API rate limit was exceeded. Check token scopes and GitHub's rate limit documentation.`;
    default:
      return `${prefix} Please check repository URL, token permissions, and GitHub status page.`;
  }
}

/**
 * Options for {@link GitHubClient}.
 */
export interface GitHubClientOptions {
  /**
   * GitHub token for authenticated requests. Needed for private repositories
   * and to avoid the stricter rate limit of anonymous requests.
   */
  readonly token?: string;

  /**
   * The `fetch` to call, undici's by default. Tests inject a fake.
   */
  readonly fetch?: typeof fetch;

  /**
   * The dispatcher passed to `fetch`; {@link createDispatcher} by default.
   */
  readonly dispatcher?: Dispatcher;
}

/**
 * A small client for the parts of the GitHub REST API the plugin needs.
 */
export class GitHubClient {
  private readonly token: string | undefined;

  private readonly send: typeof fetch;

  private readonly dispatcher: Dispatcher;

  /**
   * @param options Token, and the `fetch` and dispatcher to use.
   */
  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.send = options.fetch ?? fetch;
    this.dispatcher = options.dispatcher ?? createDispatcher();
  }

  /**
   * List the tag names of up to the latest 100 releases of a repository,
   * newest first, as GitHub returns them. Public repositories can usually be
   * read without a token; private ones need a token with the 'repo' scope.
   * Transient failures are retried before they are reported.
   *
   * @param repo The repository, as `owner/repo`.
   * @returns The tag name of every release, drafts and pre-releases included.
   * @throws {SemanticReleaseError} On a network failure, an HTTP error status,
   * or a response that is not a list of releases with a `tag_name` each.
   */
  async listReleaseTags(repo: string): Promise<readonly string[]> {
    const response = await this.send(
      `${API_ROOT}/repos/${repo}/releases?per_page=100`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        dispatcher: this.dispatcher,
      },
    ).catch((error: unknown) => {
      throw new SemanticReleaseError(
        `Network error while attempting to fetch releases from ${repo}: ${messageOf(error)}`,
      );
    });

    if (!response.ok) {
      throw new SemanticReleaseError(
        describeFailure(
          repo,
          response.status,
          response.statusText,
          Boolean(this.token),
        ),
      );
    }

    const tags = parseReleaseTags(await response.json().catch(() => undefined));
    if (tags === undefined) {
      throw new SemanticReleaseError(
        `Invalid response format received from GitHub API when fetching releases for ${repo}. Expected an array of objects with 'tag_name' strings.`,
      );
    }
    return tags;
  }
}
