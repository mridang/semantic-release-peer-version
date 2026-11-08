import SemanticReleaseError from '@semantic-release/error';
import {
  EnvHttpProxyAgent,
  RetryAgent,
  request,
  type Dispatcher,
} from 'undici';
import { STATUS_CODES } from 'node:http';
import type { Readable } from 'node:stream';
import { assertRepo } from './plugin-config.js';
import { messageOf } from './utils/error.js';
import { isRecord, stringAt } from './utils/object.js';
import { truncate } from './utils/text.js';

/**
 * The root of the GitHub REST API.
 */
const API_ROOT = 'https://api.github.com';

/**
 * The longest a whole lookup may take, retries and back-off included.
 */
const DEADLINE_MS = 120000;

/**
 * The longest a single attempt may wait for the response headers or the body.
 * An attempt that stalls is abandoned and retried.
 */
const ATTEMPT_TIMEOUT_MS = 30000;

/**
 * The longest wait between two attempts, which also caps a `Retry-After`
 * header from GitHub. It is never more than a quarter of the deadline, so the
 * waits of three retries always fit in the time budget and no timer is left
 * running once the call has failed.
 */
const MAX_BACKOFF_MS = 15000;

/**
 * How many times a request is retried, and how many times it is sent again in
 * full when the connection fails while its body is being read.
 */
const MAX_RETRIES = 3;

/**
 * Methods that are safe to repeat. The client only sends GET.
 */
const IDEMPOTENT_METHODS = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'];

/**
 * How many redirects are followed. GitHub redirects the API paths of renamed
 * repositories to the same origin. A redirect to another origin, or from https
 * to http, is never followed, so the token cannot leave for another host.
 */
const MAX_REDIRECTIONS = 3;

/**
 * Sent with every request; GitHub rejects requests that carry no user agent.
 */
const USER_AGENT = 'semantic-release-peer-version';

/**
 * The most of a response that is repeated in an error message.
 */
const MAX_DETAIL_CHARS = 2000;

/**
 * Failures worth another attempt, for the methods that may be retried. Naming
 * them replaces undici's own list, so it is repeated here with the timeout
 * codes and the two DNS and socket timeouts added.
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
  'EAI_AGAIN',
  'ETIMEDOUT',
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
 * @param attemptTimeoutMs How long one attempt may wait for the response.
 * @returns A dispatcher with connection and response timeouts.
 */
function connections(attemptTimeoutMs: number): Dispatcher {
  try {
    return connectionsThroughEnvironment(attemptTimeoutMs);
  } catch {
    // The message of undici's error holds the proxy URL, and so possibly the
    // proxy's password.
    throw new SemanticReleaseError(
      'The proxy URL in HTTP_PROXY or HTTPS_PROXY is not valid.',
      'EINVALIDPROXY',
      'Fix or unset the variable. The value is not shown because it may contain credentials.',
    );
  }
}

/**
 * Build the agent that {@link connections} describes.
 *
 * @param attemptTimeoutMs How long one attempt may wait for the response.
 * @returns A dispatcher with connection and response timeouts.
 * @throws If a proxy variable is not a valid URL.
 */
function connectionsThroughEnvironment(attemptTimeoutMs: number): Dispatcher {
  return new EnvHttpProxyAgent({
    connect: { timeout: 10000 },
    headersTimeout: attemptTimeoutMs,
    bodyTimeout: attemptTimeoutMs,
    // Measured on Node 22 and 24 against a server that keeps connections
    // open: with undici's default keep-alive a script that has made the call
    // stays alive for about 3 seconds after it. A one-shot client has no use
    // for an idle connection.
    keepAliveTimeout: 1,
    keepAliveMaxTimeout: 1,
  });
}

/**
 * Describe a failed request without a response, with the reason undici puts
 * in `cause` (it reports only `fetch failed` itself). Errors are recognised by
 * shape, because errors raised inside a sandbox come from another realm.
 *
 * @param error A caught value.
 * @returns An error with the reason in its message.
 */
function networkErrorFor(error: unknown): Error {
  return new Error(
    truncate(
      isRecord(error) && error.cause !== undefined
        ? `${messageOf(error)}: ${messageOf(error.cause)}`
        : messageOf(error),
      MAX_DETAIL_CHARS,
    ),
  );
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
 * The most of a needed response that is read. Real answers are a few
 * megabytes at most; anything larger is not worth holding in memory.
 */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * The most of an error response that is read.
 */
const MAX_ERROR_BODY_BYTES = 1024 * 1024;

/**
 * The statuses that tell the client to ask somewhere else.
 */
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

/**
 * Show where a redirect leads without its query, fragment or credentials, any
 * of which could carry a secret.
 *
 * @param from The URL that was requested.
 * @param location The `Location` header of the redirect.
 * @returns The target's origin and path, or a note when there is none.
 */
function describeLocation(
  from: string,
  location: string | string[] | undefined,
): string {
  return typeof location === 'string' && URL.canParse(location, from)
    ? (({ origin, pathname }) => `${origin}${pathname}`)(
        new URL(location, from),
      )
    : 'an invalid location';
}

/**
 * What GitHub answered, with the body already read.
 */
type Reply =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly status: number;
      readonly statusText: string;
      readonly text: string;

      /**
       * Whether GitHub said the rate limit is used up (`x-ratelimit-remaining`).
       */
      readonly rateLimited: boolean;
    };

/**
 * Read the start of a response body, at most `maxBytes`, and release the
 * connection.
 *
 * @param body The response body.
 * @param maxBytes The most to read.
 * @returns The text read, and whether the whole body fitted.
 * @throws If the connection fails before the end of the body or the limit.
 */
async function readCapped(
  body: Readable,
  maxBytes: number,
): Promise<{ readonly text: string; readonly complete: boolean }> {
  const chunks: Buffer[] = [];
  const size = (): number =>
    chunks.reduce((total, chunk) => total + chunk.length, 0);
  body.on('error', () => undefined);
  try {
    for await (const chunk of body) {
      chunks.push(Buffer.from(chunk));
      if (size() > maxBytes) {
        break;
      }
    }
  } finally {
    body.destroy();
  }
  const bytes = Buffer.concat(chunks);
  return {
    text: bytes.subarray(0, maxBytes).toString('utf8'),
    complete: bytes.length <= maxBytes,
  };
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
 * The error that describes a failed releases request.
 *
 * @param repo The repository, as `owner/repo`.
 * @param reply The failed reply.
 * @param hasToken Whether the request was authenticated.
 * @returns The error to throw, ending with GitHub's own words when it sent
 * some.
 */
function errorFor(
  repo: string,
  reply: Extract<Reply, { ok: false }>,
  hasToken: boolean,
): SemanticReleaseError {
  const prefix = `Failed to fetch releases from ${repo} (${reply.status} ${reply.statusText}).`;
  const body = parseJson(reply.text);
  const said = isRecord(body) ? stringAt(body, 'message') : undefined;
  const reason = ((): string => {
    switch (reply.status) {
      case 404:
        return hasToken
          ? `Repository not found, or the provided GitHub token does not have 'repo' scope access to it.`
          : `The repository was not found or it is private. For private repositories, please provide a GitHub token with 'repo' scope.`;
      case 401:
        return `Authentication failed. The provided GitHub token is likely invalid, expired, or does not have the 'repo' scope.`;
      case 429:
        return `GitHub is throttling requests and kept doing so after several attempts. ${hasToken ? 'Try again later.' : 'Providing a GitHub token raises the limit.'}`;
      case 403:
        if (reply.rateLimited) {
          return `The GitHub API rate limit was exceeded. ${hasToken ? 'Try again later.' : 'No GitHub token was provided, so the request counted against the much lower limit for anonymous requests; providing one raises it.'}`;
        }
        return hasToken
          ? `Access forbidden. The provided GitHub token might lack required scopes (e.g., 'repo'), or an API rate limit was exceeded. Check token scopes and GitHub's rate limit documentation.`
          : `Access forbidden. No GitHub token was provided; for private repositories, please provide one with 'repo' scope. An API rate limit may also have been exceeded.`;
      default:
        return `Please check repository URL, token permissions, and GitHub status page.`;
    }
  })();
  return new SemanticReleaseError(
    said === undefined
      ? `${prefix} ${reason}`
      : `${prefix} ${reason} GitHub said: ${truncate(said, MAX_DETAIL_CHARS)}`,
  );
}

/**
 * Options for {@link GitHubClient}. All of them exist so that tests can run
 * without the network.
 */
export interface GitHubClientOptions {
  /**
   * GitHub token for authenticated requests. Needed for private repositories
   * and to avoid the stricter rate limit of anonymous requests.
   */
  readonly token?: string;

  /** How long one attempt may wait for the response, in milliseconds. */
  readonly attemptTimeoutMs?: number;

  /** How long the whole call may take, in milliseconds. */
  readonly deadlineMs?: number;

  /** The first back-off in milliseconds, doubled for each retry. */
  readonly minTimeout?: number;

  /** The API root. Defaults to GitHub's. */
  readonly endpoint?: string;

  /** The dispatcher that is wrapped in the retrying agent. */
  readonly agent?: Dispatcher;
}

/**
 * A small client for the parts of the GitHub REST API the plugin needs. A call
 * is given up after two minutes in total, and an attempt that stalls for 30
 * seconds is abandoned and retried. Every call is a GET, which is safe to
 * repeat, so requests go through undici's `request` and `RetryAgent`: it
 * retries up to three times on throttling (429), server errors and dropped or
 * timed out connections, honouring `Retry-After` up to 15 seconds, and
 * redirects are followed up to three times. A connection that fails while the
 * body is being read makes the request be sent again in full. Once the
 * retries run out the last response is reported.
 */
export class GitHubClient {
  private readonly token: string | undefined;

  private readonly dispatcher: Dispatcher;

  private readonly endpoint: string;

  private readonly deadlineMs: number;

  /**
   * @param options The token, and test seams for the endpoint, the timeouts,
   * the back-off and the dispatcher.
   */
  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.endpoint = options.endpoint ?? API_ROOT;
    this.deadlineMs = options.deadlineMs ?? DEADLINE_MS;
    this.dispatcher = new RetryAgent(
      options.agent ??
        connections(options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS),
      {
        maxRetries: MAX_RETRIES,
        minTimeout: options.minTimeout ?? 500,
        maxTimeout: Math.min(MAX_BACKOFF_MS, Math.floor(this.deadlineMs / 4)),
        errorCodes: RETRYABLE_ERROR_CODES,
        // Hand back the last response once the retries run out, so that its
        // status is mapped like any other.
        throwOnError: false,
        methods: IDEMPOTENT_METHODS,
      },
    );
  }

  /**
   * List the tag names of up to the latest 100 releases of a repository,
   * newest first, as GitHub returns them. Public repositories can usually be
   * read without a token; private ones need a token with the 'repo' scope.
   * Transient failures are retried before they are reported.
   *
   * @param repo The repository, as `owner/repo`.
   * @returns The tag name of every release, drafts and pre-releases included.
   * @throws {SemanticReleaseError} If `repo` is not `owner/name`, on a network
   * failure, an HTTP error status, or a response that is not a list of
   * releases with a `tag_name` each.
   */
  async listReleaseTags(repo: string): Promise<readonly string[]> {
    // Before anything is sent: the token must never go to a rewritten URL.
    assertRepo(repo);
    const reply = await this.get(
      `${this.endpoint}/repos/${repo}/releases?per_page=100`,
      repo,
      AbortSignal.timeout(this.deadlineMs),
      MAX_RETRIES,
      MAX_REDIRECTIONS,
    );

    if (!reply.ok) {
      throw errorFor(
        repo,
        { ...reply, text: this.scrub(reply.text) },
        Boolean(this.token),
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
   * Send a GET request and read the body. If the connection fails after the
   * headers have arrived, undici would resume the body with a `Range`
   * request, which GitHub ignores, so the failure reaches this method and the
   * request is sent again in full instead.
   *
   * @param url The URL to fetch.
   * @param repo The repository, for error messages.
   * @param signal Aborts the call, retries included, at its deadline.
   * @param resends How many more times the request may be sent again after a
   * failure while reading the body.
   * @param hops How many more same-origin redirects may be followed.
   * @returns The status and the body text.
   * @throws {SemanticReleaseError} If the network keeps failing.
   */
  private async get(
    url: string,
    repo: string,
    signal: AbortSignal,
    resends: number,
    hops: number,
  ): Promise<Reply> {
    const failed = (error: unknown): SemanticReleaseError =>
      new SemanticReleaseError(
        `Network error while attempting to fetch releases from ${repo}: ${this.scrub(networkErrorFor(error).message)}`,
      );
    const { statusCode, headers, body } = await request(url, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': USER_AGENT,
        'x-github-api-version': '2022-11-28',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      signal,
      dispatcher: this.dispatcher,
    }).catch((error: unknown): never => {
      throw failed(error);
    });
    if (REDIRECT_STATUSES.includes(statusCode)) {
      body.on('error', () => undefined);
      body.destroy();
      const target = this.redirectTarget(url, headers['location']);
      if (target === undefined || hops <= 0) {
        throw new SemanticReleaseError(
          `Failed to fetch releases from ${repo}: GitHub answered ${statusCode} with a redirect to ${this.scrub(truncate(describeLocation(url, headers['location']), MAX_DETAIL_CHARS))}, which is not followed.`,
          'EREDIRECT',
          'Only redirects to the same origin are followed, so that the token is never sent to another host. Check the `repo` option, which may have been renamed or moved.',
        );
      }
      return this.get(target, repo, signal, resends, hops - 1);
    }
    if (statusCode < 200 || statusCode >= 300) {
      // The body only explains the failure; losing it must not change it.
      const { text } = await readCapped(body, MAX_ERROR_BODY_BYTES).catch(
        () => ({ text: '' }),
      );
      return {
        ok: false,
        status: statusCode,
        statusText: STATUS_CODES[statusCode] ?? '',
        text,
        rateLimited: headers['x-ratelimit-remaining'] === '0',
      };
    }
    const read = await readCapped(body, MAX_BODY_BYTES).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    if ('error' in read) {
      if (resends > 0) {
        return this.get(url, repo, signal, resends - 1, hops);
      }
      throw failed(read.error);
    }
    if (!read.result.complete) {
      throw new SemanticReleaseError(
        `Invalid response format received from GitHub API when fetching releases for ${repo}. The response is larger than ${MAX_BODY_BYTES / 1024 / 1024} MiB.`,
      );
    }
    return { ok: true, text: read.result.text };
  }

  /**
   * Where a redirect leads, if it may be followed.
   *
   * @param from The URL that was requested.
   * @param location The `Location` header of the redirect.
   * @returns The URL to request next, or undefined when the header is missing
   * or invalid, or the target is another origin (which includes a change from
   * https to http).
   */
  private redirectTarget(
    from: string,
    location: string | string[] | undefined,
  ): string | undefined {
    if (typeof location !== 'string' || !URL.canParse(location, from)) {
      return undefined;
    }
    const target = new URL(location, from);
    return target.origin === new URL(from).origin ? target.href : undefined;
  }

  /**
   * Remove the token from text that is about to be shown. A library may quote
   * a header value that it rejects, and a server may echo what it was sent.
   *
   * @param text Text that came from the network or from a library.
   * @returns The text with every form of the token replaced.
   */
  private scrub(text: string): string {
    const forms = this.token
      ? [
          this.token,
          encodeURIComponent(this.token),
          new URLSearchParams({ t: this.token }).toString().slice(2),
        ]
      : [];
    return forms.reduce(
      (out, form) => out.replaceAll(form, '[redacted]'),
      text,
    );
  }
}
