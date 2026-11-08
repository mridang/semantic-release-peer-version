import SemanticReleaseError from '@semantic-release/error';
import {
  RetryAgent,
  fetch,
  getGlobalDispatcher,
  type Dispatcher,
} from 'undici';
import { messageOf } from './utils/error.js';
import { isRecord, stringAt } from './utils/object.js';

const API_ROOT = 'https://api.github.com';

const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Create the dispatcher the client uses by default. Every request made through
 * it is a GET, which is safe to repeat, so throttling (429), server errors
 * (500, 502, 503, 504), dropped connections and connection or header timeouts
 * are retried with exponential backoff. A `Retry-After` header is honoured but
 * never waited on for longer than ten seconds. When the retries run out, the
 * last response is returned so that its status can be explained.
 *
 * @param base The dispatcher to wrap; undici's global one by default, so
 * proxy settings made for the process apply.
 * @returns A dispatcher that retries idempotent requests.
 */
export function createDispatcher(
  base: Dispatcher = getGlobalDispatcher(),
): Dispatcher {
  return new RetryAgent(base, {
    maxRetries: 3,
    minTimeout: 500,
    maxTimeout: 10_000,
    timeoutFactor: 2,
    methods: ['GET'],
    throwOnError: false,
    errorCodes: [
      'ECONNRESET',
      'ECONNREFUSED',
      'ENOTFOUND',
      'ENETDOWN',
      'ENETUNREACH',
      'EHOSTDOWN',
      'EHOSTUNREACH',
      'EPIPE',
      'UND_ERR_SOCKET',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
    ],
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
 * Why a request failed. Undici reports every failure as "fetch failed" and
 * keeps the real reason (a DNS error, a timeout) in the error's cause.
 *
 * @param error The error `fetch` rejected with.
 * @returns Its message, followed by the message of its cause when it has one.
 */
function reasonOf(error: unknown): string {
  return error instanceof Error && error.cause !== undefined
    ? `${error.message} (${messageOf(error.cause)})`
    : messageOf(error);
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

  /**
   * Upper bound, in milliseconds, for a whole call including its retries.
   */
  readonly timeoutMs?: number;
}

/**
 * A small client for the parts of the GitHub REST API the plugin needs.
 */
export class GitHubClient {
  private readonly token: string | undefined;

  private readonly send: typeof fetch;

  private readonly dispatcher: Dispatcher | undefined;

  private readonly timeoutMs: number;

  /**
   * @param options Token, and the `fetch` and dispatcher to use.
   */
  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.send = options.fetch ?? fetch;
    this.dispatcher = options.dispatcher;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
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
        dispatcher: this.dispatcher ?? createDispatcher(),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    ).catch((error: unknown) => {
      throw new SemanticReleaseError(
        `Network error while attempting to fetch releases from ${repo}: ${reasonOf(error)}`,
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
