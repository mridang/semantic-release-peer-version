import { describe, expect, it, jest } from '@jest/globals';
import { createServer, type ServerResponse } from 'node:http';
import { MockAgent } from 'undici';
// noinspection ES6PreferShortImport
import { GitHubClient, type GitHubClientOptions } from '../src/github.js';
import { messageOf } from '../src/utils/error.js';
import { startLoopback } from './utils/server.js';
import { startTunnelProxy } from './utils/proxy.js';

const PATH = '/api/update-package/repos/o/r/releases?per_page=100';

const json = (
  response: ServerResponse,
  status: number,
  body: unknown,
): void => {
  response
    .writeHead(status, { 'Content-Type': 'application/json' })
    .end(typeof body === 'string' ? body : JSON.stringify(body));
};

const tags = (response: ServerResponse): void => {
  json(response, 200, [{ tag_name: 'v5.0.0' }]);
};

/**
 * Run a test against a real HTTP server on the loopback interface, which keeps
 * the response headers and sockets that a mock agent does not.
 *
 * @param respond Answers each request; the first argument is its number.
 * @param run The test body, given a client pointed at the server.
 * @param options Overrides for the client.
 * @returns What the server saw.
 */
const withServer = async (
  respond: Parameters<typeof startLoopback>[0],
  run: (client: GitHubClient) => Promise<void>,
  options: GitHubClientOptions = {},
): Promise<Awaited<ReturnType<typeof startLoopback>>['seen']> => {
  const server = await startLoopback(respond);
  try {
    await run(
      new GitHubClient({ endpoint: server.url, minTimeout: 1, ...options }),
    );
    return server.seen;
  } finally {
    await server.close();
  }
};

const failure = async (client: GitHubClient): Promise<string> =>
  client.listReleaseTags('o/r').then(
    () => 'resolved',
    (error: unknown) => messageOf(error),
  );

describe('GitHubClient.listReleaseTags', () => {
  it('lists the tag names, asking GitHub for the latest 100 releases', async () => {
    const seen = await withServer(
      (_attempt, response) => {
        json(response, 200, [{ tag_name: 'v1.0.0' }, { tag_name: 'v2.0.0' }]);
      },
      async (client) => {
        await expect(client.listReleaseTags('o/r')).resolves.toEqual([
          'v1.0.0',
          'v2.0.0',
        ]);
      },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(PATH);
    expect(seen[0]?.headers).toMatchObject({
      accept: 'application/vnd.github+json',
      'user-agent': 'semantic-release-peer-version',
      'x-github-api-version': '2022-11-28',
    });
    expect(seen[0]?.headers['authorization']).toBeUndefined();
  });

  it('sends the token as a bearer credential when one is given', async () => {
    const seen = await withServer(
      (_attempt, response) => tags(response),
      async (client) => {
        await client.listReleaseTags('o/r');
      },
      { token: 'TOKEN' },
    );

    expect(seen[0]?.headers['authorization']).toBe('Bearer TOKEN');
  });

  it.each([
    [404, undefined, /The repository was not found or it is private/],
    [404, 'TOKEN', /does not have 'repo' scope access to it/],
    [401, 'TOKEN', /Authentication failed/],
    [403, 'TOKEN', /Access forbidden. The provided GitHub token might lack/],
    [403, undefined, /Access forbidden. No GitHub token was provided/],
    [429, undefined, /throttling requests.*Providing a GitHub token raises/],
    [429, 'TOKEN', /throttling requests.*Try again later/],
    [500, undefined, /Please check repository URL, token permissions/],
  ])('explains HTTP %s (token: %s)', async (status, token, message) => {
    await withServer(
      (_attempt, response) => json(response, status, {}),
      async (client) => {
        const text = await failure(client);
        expect(text).toMatch(
          new RegExp(`^Failed to fetch releases from o/r \\(${status} `),
        );
        expect(text).toMatch(message);
      },
      { token },
    );
  });

  it.each([
    ['an object', { tag_name: 'v1.0.0' }],
    ['a list with an item that has no tag', [{ tag_name: 'v1.0.0' }, {}]],
    ['a list with a non-string tag', [{ tag_name: 1 }]],
    ['a list of non-objects', ['v1.0.0']],
    ['text that is not JSON', 'not json'],
  ])('rejects %s as an invalid response', async (_name, body) => {
    await withServer(
      (_attempt, response) => json(response, 200, body),
      async (client) => {
        expect(await failure(client)).toMatch(
          /^Invalid response format received from GitHub API when fetching releases for o\/r\./,
        );
      },
    );
  });

  it('refuses a repo that is not owner/name without sending anything', async () => {
    const seen = await withServer(
      (_attempt, response) => tags(response),
      async (client) => {
        for (const repo of ['o/r?per_page=1', 'o/r/../../x', 'o']) {
          await expect(client.listReleaseTags(repo)).rejects.toMatchObject({
            code: 'EINVALIDREPO',
          });
        }
      },
      { token: 'TOKEN' },
    );

    expect(seen).toHaveLength(0);
  });
});

describe('GitHubClient failure messages', () => {
  it('names the rate limit and does not blame a token that was not sent', async () => {
    await withServer(
      (_attempt, response) => {
        response
          .writeHead(403, { 'x-ratelimit-remaining': '0' })
          .end('{"message":"API rate limit exceeded for 1.2.3.4."}');
      },
      async (client) => {
        const text = await failure(client);
        expect(text).toContain('No GitHub token was provided');
        expect(text).not.toContain('might lack required scopes');
        expect(text).toMatch(
          /GitHub said: API rate limit exceeded for 1\.2\.3\.4\.$/,
        );
      },
    );
  });

  it('does not suggest a token when one was used', async () => {
    await withServer(
      (_attempt, response) => {
        response.writeHead(403, { 'x-ratelimit-remaining': '0' }).end('{}');
      },
      async (client) => {
        expect(await failure(client)).toContain(
          'rate limit was exceeded. Try again later.',
        );
      },
      { token: 'TOKEN' },
    );
  });

  it("cuts GitHub's own message short", async () => {
    await withServer(
      (_attempt, response) => {
        json(response, 404, { message: 'x'.repeat(100_000) });
      },
      async (client) => {
        const text = await failure(client);
        expect(text.endsWith(`${'x'.repeat(2000)}... (truncated)`)).toBe(true);
        expect(text.length).toBeLessThan(2600);
      },
    );
  });

  it('does not read an error body without end', async () => {
    await withServer(
      (_attempt, response) => {
        response.writeHead(404);
        response.write('x'.repeat(2 * 1024 * 1024));
        response.end();
      },
      async (client) => {
        expect(await failure(client)).toMatch(
          /^Failed to fetch releases from o\/r \(404 /,
        );
      },
    );
  });

  it('still reports the status when the error body is cut off', async () => {
    await withServer(
      (_attempt, response) => {
        response.writeHead(404, { 'Content-Length': '100' });
        response.write('{"mess');
        setTimeout(() => response.socket?.destroy(), 20);
      },
      async (client) => {
        expect(await failure(client)).toMatch(
          /^Failed to fetch releases from o\/r \(404 /,
        );
      },
    );
  });

  it('refuses a successful body larger than the cap', async () => {
    await withServer(
      (_attempt, response) => {
        response.writeHead(200);
        response.write(Buffer.alloc(33 * 1024 * 1024, 'x'));
        response.end();
      },
      async (client) => {
        expect(await failure(client)).toMatch(/is larger than 32 MiB\.$/);
      },
    );
  });
});

describe('GitHubClient credentials', () => {
  it('keeps the token out of an error the server echoes', async () => {
    await withServer(
      (_attempt, response) => {
        json(response, 404, {
          message: 'no such repo for Bearer SECRET-TOKEN',
        });
      },
      async (client) => {
        const text = await failure(client);
        expect(text).toContain(
          'GitHub said: no such repo for Bearer [redacted]',
        );
        expect(text).not.toContain('SECRET-TOKEN');
      },
      { token: 'SECRET-TOKEN' },
    );
  });

  it('keeps a token that is not a legal header value out of the error', async () => {
    await withServer(
      (_attempt, response) => tags(response),
      async (client) => {
        const text = await failure(client);
        expect(text).toMatch(
          /^Network error while attempting to fetch releases/,
        );
        expect(text).not.toContain('SEC RET');
      },
      { token: 'SEC RET\nX: y' },
    );
  });
});

describe('GitHubClient retries', () => {
  it.each([429, 503])('honours Retry-After on a %s', async (status) => {
    const started = Date.now();

    const seen = await withServer(
      (attempt, response) => {
        if (attempt === 1) {
          response.writeHead(status, { 'Retry-After': '1' }).end('slow down');
        } else {
          tags(response);
        }
      },
      async (client) => {
        await expect(client.listReleaseTags('o/r')).resolves.toEqual([
          'v5.0.0',
        ]);
      },
    );

    expect(seen).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('retries a reset connection', async () => {
    const seen = await withServer(
      (attempt, response) => {
        if (attempt === 1) {
          response.socket?.destroy();
        } else {
          tags(response);
        }
      },
      async (client) => {
        await expect(client.listReleaseTags('o/r')).resolves.toEqual([
          'v5.0.0',
        ]);
      },
    );

    expect(seen).toHaveLength(2);
  });

  it('reports the status once the retries have run out', async () => {
    const seen = await withServer(
      (_attempt, response) => json(response, 503, 'unavailable'),
      async (client) => {
        expect(await failure(client)).toMatch(
          /^Failed to fetch releases from o\/r \(503 Service Unavailable\)\. Please check/,
        );
      },
    );

    expect(seen).toHaveLength(4);
  });

  it('names the cause of a failure that wraps another', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get('https://api.github.com')
      .intercept({ path: '/repos/o/r/releases?per_page=100', method: 'GET' })
      .replyWithError(
        Object.assign(new Error('outer', { cause: new Error('inner') }), {
          code: 'ECONNRESET',
        }),
      )
      .persist();

    expect(await failure(new GitHubClient({ agent, minTimeout: 1 }))).toMatch(
      /: outer: inner$/,
    );
  });

  it('reports a status that has no standard name', async () => {
    await withServer(
      (_attempt, response) => {
        response.writeHead(499).end('{}');
      },
      async (client) => {
        expect(await failure(client)).toMatch(/\(499 \)\./);
      },
    );
  });

  it('does not retry a client error', async () => {
    const seen = await withServer(
      (_attempt, response) => json(response, 404, {}),
      async (client) => {
        expect(await failure(client)).toMatch(/\(404 Not Found\)/);
      },
    );

    expect(seen).toHaveLength(1);
  });

  it.each([
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
  ])('retries a %s failure', async (code) => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get('https://api.github.com');
    pool
      .intercept({ path: '/repos/o/r/releases?per_page=100', method: 'GET' })
      .replyWithError(Object.assign(new Error('failed'), { code }));
    pool
      .intercept({ path: '/repos/o/r/releases?per_page=100', method: 'GET' })
      .reply(200, [{ tag_name: 'v3.0.0' }]);

    await expect(
      new GitHubClient({ agent, minTimeout: 1 }).listReleaseTags('o/r'),
    ).resolves.toEqual(['v3.0.0']);
    agent.assertNoPendingInterceptors();
  });

  const cutShort = (_attempt: number, response: ServerResponse): void => {
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': '100',
    });
    response.write('[{"tag_na');
    setTimeout(() => response.socket?.destroy(), 20);
  };

  it('sends the whole request again when the connection drops during the body', async () => {
    const seen = await withServer(
      (attempt, response) => {
        if (attempt === 1) {
          cutShort(attempt, response);
        } else {
          tags(response);
        }
      },
      async (client) => {
        await expect(client.listReleaseTags('o/r')).resolves.toEqual([
          'v5.0.0',
        ]);
      },
    );

    expect(seen.at(-1)?.headers['range']).toBeUndefined();
  });

  it('reports a body that keeps failing as a network error', async () => {
    await withServer(cutShort, async (client) => {
      expect(await failure(client)).toMatch(
        /^Network error while attempting to fetch releases from o\/r: /,
      );
    });
  });

  it('retries an attempt that stalls', async () => {
    const seen = await withServer(
      (attempt, response) => {
        if (attempt > 1) {
          tags(response);
        }
      },
      async (client) => {
        await expect(client.listReleaseTags('o/r')).resolves.toEqual([
          'v5.0.0',
        ]);
      },
      { attemptTimeoutMs: 100 },
    );

    expect(seen).toHaveLength(2);
  });

  it('gives up on a server that never answers once the deadline is up', async () => {
    const started = Date.now();

    await withServer(
      () => undefined,
      async (client) => {
        expect(await failure(client)).toMatch(
          /^Network error while attempting/,
        );
      },
      { deadlineMs: 200 },
    );

    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('leaves no retry timer running once the deadline has passed', async () => {
    const timers = (): number =>
      process.getActiveResourcesInfo().filter((name) => name === 'Timeout')
        .length;
    const before = timers();

    await withServer(
      (_attempt, response) => {
        response.writeHead(503, { 'Retry-After': '3600' }).end('busy');
      },
      async (client) => {
        expect(await failure(client)).toMatch(
          /^(Network error while attempting|Failed to fetch releases from o\/r \(503)/,
        );
      },
      { deadlineMs: 400 },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(timers()).toBeLessThanOrEqual(before);
  });
});

describe('GitHubClient redirects', () => {
  it('follows a redirect to a renamed repository on the same origin', async () => {
    const seen = await withServer(
      (attempt, response) => {
        if (attempt === 1) {
          response
            .writeHead(301, {
              Location: '/api/update-package/repos/new/r/releases?per_page=100',
            })
            .end();
        } else {
          tags(response);
        }
      },
      async (client) => {
        await expect(client.listReleaseTags('old/r')).resolves.toEqual([
          'v5.0.0',
        ]);
      },
      { token: 'SECRET-TOKEN' },
    );

    expect(seen[1]?.url).toBe(
      '/api/update-package/repos/new/r/releases?per_page=100',
    );
    expect(seen[1]?.headers['authorization']).toBe('Bearer SECRET-TOKEN');
  });

  it('does not follow a redirect to another origin, so the token stays put', async () => {
    const target = await startLoopback((_attempt, response) => tags(response));
    try {
      const seen = await withServer(
        (_attempt, response) => {
          response
            .writeHead(302, { Location: `${target.url}/x?secret=1#frag` })
            .end();
        },
        async (client) => {
          const text = await failure(client);
          expect(text).toContain('answered 302 with a redirect to');
          expect(text).toContain(`${target.url}/x, which is not followed`);
          expect(text).not.toContain('secret=1');
        },
        { token: 'SECRET-TOKEN' },
      );

      expect(seen).toHaveLength(1);
      expect(target.seen).toHaveLength(0);
    } finally {
      await target.close();
    }
  });

  it('does not follow a redirect from https to http', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get('https://api.github.com')
      .intercept({ path: '/repos/o/r/releases?per_page=100', method: 'GET' })
      .reply(301, '', {
        headers: {
          location: 'http://api.github.com/repos/n/r/releases?access=1',
        },
      });

    const text = await failure(
      new GitHubClient({ agent, token: 'SECRET-TOKEN', minTimeout: 1 }),
    );

    expect(text).toContain(
      'answered 301 with a redirect to http://api.github.com/repos/n/r/releases, which is not followed',
    );
    expect(text).not.toContain('access=1');
  });

  it('gives up after three redirects', async () => {
    const seen = await withServer(
      (_attempt, response) => {
        response.writeHead(301, { Location: '/again' }).end();
      },
      async (client) => {
        expect(await failure(client)).toContain('which is not followed');
      },
    );

    expect(seen).toHaveLength(4);
  });

  it('reports a redirect without a location', async () => {
    await withServer(
      (_attempt, response) => {
        response.writeHead(302).end();
      },
      async (client) => {
        expect(await failure(client)).toContain('an invalid location');
      },
    );
  });
});

describe('GitHubClient proxy', () => {
  /**
   * Run a test with proxy variables in the environment.
   *
   * @param variables The variables to set; the others are removed.
   * @param run The test body.
   */
  const withProxyEnv = async (
    variables: Readonly<Record<string, string>>,
    run: () => Promise<void>,
  ): Promise<void> => {
    const {
      HTTP_PROXY,
      http_proxy,
      HTTPS_PROXY,
      https_proxy,
      NO_PROXY,
      no_proxy,
      ...rest
    } = process.env;
    void [HTTP_PROXY, http_proxy, HTTPS_PROXY, https_proxy, NO_PROXY, no_proxy];
    const env = jest.replaceProperty(process, 'env', { ...rest, ...variables });
    try {
      await run();
    } finally {
      env.restore();
    }
  };

  const target = async (): Promise<{
    port: number;
    close: () => Promise<void>;
  }> => {
    const server = createServer((_request, response) => tags(response));
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    return {
      port: address !== null && typeof address === 'object' ? address.port : 0,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  };

  it('sends requests through the proxy named in HTTP_PROXY', async () => {
    const backend = await target();
    const proxy = await startTunnelProxy(backend.port);
    try {
      await withProxyEnv({ HTTP_PROXY: proxy.url, NO_PROXY: '' }, async () => {
        const client = new GitHubClient({ endpoint: 'http://github.invalid' });

        await expect(client.listReleaseTags('o/r')).resolves.toEqual([
          'v5.0.0',
        ]);
      });
      expect(proxy.tunnelled).toEqual(['github.invalid:80']);
    } finally {
      await proxy.close();
      await backend.close();
    }
  });

  it('tunnels https requests through the proxy named in HTTPS_PROXY', async () => {
    const tunnelled: string[] = [];
    const proxy = createServer();
    proxy.on('connect', (request, socket) => {
      tunnelled.push(request.url ?? '');
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    const port =
      address !== null && typeof address === 'object' ? address.port : 0;
    try {
      await withProxyEnv(
        { HTTPS_PROXY: `http://127.0.0.1:${port}`, NO_PROXY: '' },
        async () => {
          const client = new GitHubClient({
            endpoint: 'https://github.invalid',
            minTimeout: 1,
          });

          // A refused tunnel names the proxy's answer.
          expect(await failure(client)).toMatch(
            /^Network error while attempting to fetch releases from o\/r: .*Proxy response \(502\)/,
          );
        },
      );
      expect(tunnelled[0]).toBe('github.invalid:443');
    } finally {
      proxy.closeAllConnections();
      proxy.close();
    }
  });

  it('bypasses the proxy for hosts in NO_PROXY', async () => {
    const backend = await target();
    const proxy = await startTunnelProxy(backend.port);
    try {
      await withProxyEnv(
        { HTTP_PROXY: proxy.url, NO_PROXY: '127.0.0.1' },
        async () => {
          const client = new GitHubClient({
            endpoint: `http://127.0.0.1:${backend.port}`,
          });

          await expect(client.listReleaseTags('o/r')).resolves.toEqual([
            'v5.0.0',
          ]);
        },
      );
      expect(proxy.tunnelled).toEqual([]);
    } finally {
      await proxy.close();
      await backend.close();
    }
  });

  it('explains a proxy variable that is not a URL without showing it', async () => {
    await withProxyEnv({ HTTPS_PROXY: 'http://user:hunter2@a b' }, async () => {
      const error = await Promise.resolve()
        .then(() => new GitHubClient({}))
        .catch((e: unknown) => e);

      expect(error).toMatchObject({ code: 'EINVALIDPROXY' });
      expect(JSON.stringify(error)).not.toContain('hunter2');
      expect(messageOf(error)).not.toContain('hunter2');
    });
  });

  it('names the reason when a connection is refused, without the token', async () => {
    const probe = await startLoopback(() => undefined);
    await probe.close();
    const client = new GitHubClient({
      token: 'SECRET-TOKEN',
      endpoint: probe.url,
      minTimeout: 1,
    });

    const text = await failure(client);

    expect(text).toMatch(/ECONNREFUSED/);
    expect(text).not.toContain('SECRET-TOKEN');
  });
});
