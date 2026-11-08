import SemanticReleaseError from '@semantic-release/error';
import { EnvHttpProxyAgent, RetryAgent, fetch, type Dispatcher } from 'undici';
import { messageOf } from './utils/error.js';
import { isRecord, stringAt } from './utils/object.js';

const API_ROOT = 'https://api.github.com';

/**
 * GitHub rejects requests that carry no user agent.
 */
const USER_AGENT = '@mridang/semantic-release-peer-version';

/**
 * How many times a request is sent again in full when the connection fails
 * while its body is being read.
 */
const BODY_RESENDS = 2;

/**
 * The longest a whole call may take, retries and back-off included.
 */
const TOTAL_TIMEOUT_MS = 120000;

/**
 * The longest wait between two attempts, which also caps a `Retry-After`
 * header from GitHub.
 */
const MAX_BACKOFF_MS = 15000;

/**
 * Failures worth another attempt, for the methods that may be retried. Naming
 * them replaces undici's own list, so it is repeated here with the three
 * timeout codes added.
 */
const RETRYABLE_ERROR_CODES = [
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
  'UND_ERR_BODY_TIMEOUT',
];

/**
 * The connections to GitHub, from the installed `undici` (the runtime's
 * bundled undici cannot be wrapped by `RetryAgent`). They honour the
 * `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` environment variables, as Node's
 * own `fetch` does under `NODE_USE_ENV_PROXY`; the variables are read when a
 * client is built.
 *
 * @returns A dispatcher with connection and response timeouts.
 */
function connections(): Dispatcher {
  return new EnvHttpProxyAgent({
    connect: { timeout: 10000 },
    headersTimeout: 30000,
    bodyTimeout: 30000,
    // One lookup per run: do not keep the socket (and so the process) alive
    // afterwards.
    keepAliveTimeout: 1,
    keepAliveMaxTimeout: 1,
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
 * What GitHub answered, with the body already read.
 */
interface Reply {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly text: string;
}

/**
 * Parse a response body.
 *
 * @param text The body.
 * @returns The parsed JSON, or undefined when the body is not JSON.
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
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
    ? `${error.message}: ${messageOf(error.cause)}`
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

  /** The `fetch` to call, undici's by default. Tests inject a fake. */
  readonly fetch?: typeof fetch;

  /** The dispatcher that is wrapped in the retrying agent. */
  readonly agent?: Dispatcher;

  /** The API root. Defaults to GitHub's. */
  readonly endpoint?: string;

  /** The first back-off in milliseconds, doubled for each retry. */
  readonly minTimeout?: number;

  /** The longest a whole call may take, in milliseconds. */
  readonly timeoutMs?: number;
}

/**
 * A small client for the parts of the GitHub REST API the plugin needs. Every
 * call is a GET, which is safe to repeat, so requests go through undici's
 * `RetryAgent`: it retries up to three times on throttling (429), server
 * errors and dropped or timed out connections, honouring `Retry-After` up to
 * 15 seconds. Once the retries run out the last response is reported. A call
 * is given up after two minutes in total.
 */
export class GitHubClient {
  private readonly token: string | undefined;

  private readonly send: typeof fetch;

  private readonly dispatcher: Dispatcher;

  private readonly endpoint: string;

  private readonly timeoutMs: number;

  /**
   * @param options The token, and test seams for the `fetch`, the dispatcher,
   * the endpoint and the timeouts.
   */
  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.send = options.fetch ?? fetch;
    this.endpoint = options.endpoint ?? API_ROOT;
    this.timeoutMs = options.timeoutMs ?? TOTAL_TIMEOUT_MS;
    this.dispatcher = new RetryAgent(options.agent ?? connections(), {
      maxRetries: 3,
      minTimeout: options.minTimeout ?? 500,
      maxTimeout: MAX_BACKOFF_MS,
      timeoutFactor: 2,
      methods: ['GET'],
      errorCodes: RETRYABLE_ERROR_CODES,
      // Hand back the last response once the retries run out, so that its
      // status is mapped like any other.
      throwOnError: false,
    });
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
    const reply = await this.get(
      `${this.endpoint}/repos/${repo}/releases?per_page=100`,
      repo,
      AbortSignal.timeout(this.timeoutMs),
      BODY_RESENDS,
    );

    if (!reply.ok) {
      throw new SemanticReleaseError(
        describeFailure(
          repo,
          reply.status,
          reply.statusText,
          Boolean(this.token),
        ),
      );
    }

    const tags = parseReleaseTags(parseJson(reply.text));
    if (tags === undefined) {
      throw new SemanticReleaseError(
        `Invalid response format received from GitHub API when fetching releases for ${repo}. Expected an array of objects with 'tag_name' strings.`,
      );
    }
    return tags;
  }

  /**
   * Send a GET request and read the whole body. If the connection fails after
   * the headers have arrived, undici would resume the body with a `Range`
   * request, which GitHub ignores, so the failure reaches this method and the
   * request is sent again in full instead.
   *
   * @param url The URL to fetch.
   * @param repo The repository, for error messages.
   * @param signal Aborts the call, retries included, at its deadline.
   * @param resends How many more times the request may be sent again after a
   * failure while reading the body.
   * @returns The status and the body text.
   * @throws {SemanticReleaseError} If the network keeps failing.
   */
  private async get(
    url: string,
    repo: string,
    signal: AbortSignal,
    resends: number,
  ): Promise<Reply> {
    const failed = (error: unknown): SemanticReleaseError =>
      new SemanticReleaseError(
        `Network error while attempting to fetch releases from ${repo}: ${reasonOf(error)}`,
      );
    const response = await this.send(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      dispatcher: this.dispatcher,
      signal,
    }).catch((error: unknown): never => {
      throw failed(error);
    });
    // Always read the body, so that the connection is released.
    const text = await response.text().then(
      (body) => ({ body }),
      (error: unknown) => ({ error }),
    );
    if ('error' in text) {
      if (resends > 0 && !signal.aborted) {
        return this.get(url, repo, signal, resends - 1);
      }
      throw failed(text.error);
    }
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      text: text.body,
    };
  }
}
