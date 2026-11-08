import { describe, expect, it, jest } from '@jest/globals';
import { createServer, type RequestListener } from 'node:http';
import { messageOf } from '../src/utils/error.js';
import { startTunnelProxy } from './utils/proxy.js';
import { Agent, MockAgent, Response } from 'undici';
// noinspection ES6PreferShortImport
import { GitHubClient, type GitHubClientOptions } from '../src/github.js';

type Fetch = NonNullable<GitHubClientOptions['fetch']>;

const PATH = '/repos/o/r/releases?per_page=100';

/**
 * A fake `fetch` that answers every request with the given response.
 *
 * @param status HTTP status to answer with.
 * @param body Body to answer with; objects are sent as JSON.
 * @returns The fake, which records its calls.
 */
const fakeFetch = (status: number, body: unknown) =>
  jest.fn<Fetch>(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        statusText: status === 200 ? 'OK' : 'Failure',
      }),
  );

describe('GitHubClient.listReleaseTags', () => {
  it('lists the tag names, asking GitHub for the latest 100 releases', async () => {
    const send = fakeFetch(200, [
      { tag_name: 'v1.0.0' },
      { tag_name: 'v2.0.0' },
    ]);

    const tags = await new GitHubClient({ fetch: send }).listReleaseTags('o/r');

    expect(tags).toEqual(['v1.0.0', 'v2.0.0']);
    expect(send.mock.calls[0]?.[0]).toBe(`https://api.github.com${PATH}`);
    expect(send.mock.calls[0]?.[1]?.headers).toEqual({
      Accept: 'application/vnd.github+json',
      'User-Agent': '@mridang/semantic-release-peer-version',
      'X-GitHub-Api-Version': '2022-11-28',
    });
  });

  it('sends the token as a bearer credential when one is given', async () => {
    const send = fakeFetch(200, []);

    await new GitHubClient({ token: 'TOKEN', fetch: send }).listReleaseTags(
      'o/r',
    );

    expect(send.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer TOKEN',
    });
  });

  it('bounds the whole call with a timeout', async () => {
    const send = fakeFetch(200, []);

    await new GitHubClient({ fetch: send }).listReleaseTags('o/r');

    expect(send.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports the cause of a network failure', async () => {
    const send = jest.fn<Fetch>().mockRejectedValue(
      new TypeError('fetch failed', {
        cause: new Error('getaddrinfo ENOTFOUND api.github.com'),
      }),
    );

    await expect(
      new GitHubClient({ fetch: send }).listReleaseTags('o/r'),
    ).rejects.toThrow('fetch failed: getaddrinfo ENOTFOUND api.github.com');
  });

  it('reports a network failure', async () => {
    const send = jest.fn<Fetch>().mockRejectedValue(new Error('offline'));

    await expect(
      new GitHubClient({ fetch: send }).listReleaseTags('o/r'),
    ).rejects.toThrow(
      'Network error while attempting to fetch releases from o/r: offline',
    );
  });

  it.each([
    [404, undefined, /The repository was not found or it is private/],
    [404, 'TOKEN', /does not have 'repo' scope access to it/],
    [401, 'TOKEN', /Authentication failed/],
    [403, 'TOKEN', /Access forbidden/],
    [500, undefined, /Please check repository URL, token permissions/],
  ])('explains HTTP %s (token: %s)', async (status, token, message) => {
    const client = new GitHubClient({
      token,
      fetch: fakeFetch(status, {}),
    });

    await expect(client.listReleaseTags('o/r')).rejects.toThrow(
      new RegExp(
        `^Failed to fetch releases from o/r \\(${status} Failure\\)\\. `,
      ),
    );
    await expect(client.listReleaseTags('o/r')).rejects.toThrow(message);
  });

  it.each([
    ['an object', { tag_name: 'v1.0.0' }],
    ['a list with an item that has no tag', [{ tag_name: 'v1.0.0' }, {}]],
    ['a list with a non-string tag', [{ tag_name: 1 }]],
    ['a list of non-objects', ['v1.0.0']],
    ['text that is not JSON', 'not json'],
  ])('rejects %s as an invalid response', async (_name, body) => {
    const client = new GitHubClient({ fetch: fakeFetch(200, body) });

    await expect(client.listReleaseTags('o/r')).rejects.toThrow(
      /^Invalid response format received from GitHub API when fetching releases for o\/r\./,
    );
  });
});

describe('GitHubClient repo check', () => {
  it.each(['o/r?per_page=1', 'o/r/../../x', 'o'])(
    'refuses %s without sending anything, so the token stays put',
    async (repo) => {
      const send = fakeFetch(200, []);

      await expect(
        new GitHubClient({ token: 'TOKEN', fetch: send }).listReleaseTags(repo),
      ).rejects.toMatchObject({ code: 'EINVALIDREPO' });
      expect(send).not.toHaveBeenCalled();
    },
  );
});

describe('GitHubClient retries', () => {
  const retrying = (agent: MockAgent) =>
    new GitHubClient({ agent, minTimeout: 1 });

  const mockAgent = (): MockAgent => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    return agent;
  };

  it('retries a server error and returns the later success', async () => {
    const agent = mockAgent();
    const pool = agent.get('https://api.github.com');
    pool.intercept({ path: PATH, method: 'GET' }).reply(503, 'unavailable');
    pool
      .intercept({ path: PATH, method: 'GET' })
      .reply(200, [{ tag_name: 'v3.0.0' }]);

    await expect(retrying(agent).listReleaseTags('o/r')).resolves.toEqual([
      'v3.0.0',
    ]);
    agent.assertNoPendingInterceptors();
  });

  it('retries a dropped connection', async () => {
    const agent = mockAgent();
    const pool = agent.get('https://api.github.com');
    pool
      .intercept({ path: PATH, method: 'GET' })
      .replyWithError(
        Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
      );
    pool.intercept({ path: PATH, method: 'GET' }).reply(200, []);

    await expect(retrying(agent).listReleaseTags('o/r')).resolves.toEqual([]);
    agent.assertNoPendingInterceptors();
  });

  it('explains the status once the retries have run out', async () => {
    const agent = mockAgent();
    agent
      .get('https://api.github.com')
      .intercept({ path: PATH, method: 'GET' })
      .reply(503, 'unavailable')
      .times(4);

    await expect(retrying(agent).listReleaseTags('o/r')).rejects.toThrow(
      /^Failed to fetch releases from o\/r \(503 .*\)\. Please check repository URL/,
    );
    agent.assertNoPendingInterceptors();
  });

  it('does not retry a client error', async () => {
    const agent = mockAgent();
    agent
      .get('https://api.github.com')
      .intercept({ path: PATH, method: 'GET' })
      .reply(404, {});

    await expect(retrying(agent).listReleaseTags('o/r')).rejects.toThrow(
      /\(404 Not Found\)/,
    );
    agent.assertNoPendingInterceptors();
  });
});

describe('GitHubClient against a local server', () => {
  /**
   * Run a test against a real HTTP server on the loopback interface, which
   * keeps the response headers and sockets that a mock agent does not.
   *
   * @param listener Handles each request.
   * @param run The test body, given a client pointed at the server.
   */
  const withServer = async (
    listener: RequestListener,
    run: (client: GitHubClient, port: number) => Promise<void>,
    options: GitHubClientOptions = {},
  ): Promise<void> => {
    const server = createServer(listener);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    const port =
      address !== null && typeof address === 'object' ? address.port : 0;
    try {
      await run(
        new GitHubClient({
          endpoint: `http://127.0.0.1:${port}`,
          agent: new Agent(),
          ...options,
        }),
        port,
      );
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  };

  it('waits for Retry-After before retrying a 503', async () => {
    const handler = jest
      .fn<RequestListener>()
      .mockImplementationOnce((_request, response) => {
        response.writeHead(503, { 'Retry-After': '1' }).end('busy');
      })
      .mockImplementation((_request, response) => {
        response
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end('[{"tag_name":"v4.0.0"}]');
      });
    const started = Date.now();

    await withServer(handler, async (client) => {
      await expect(client.listReleaseTags('o/r')).resolves.toEqual(['v4.0.0']);
    });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('retries a connection that is reset', async () => {
    const handler = jest
      .fn<RequestListener>()
      .mockImplementationOnce((request) => {
        request.socket.destroy();
      })
      .mockImplementation((_request, response) => {
        response
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end('[]');
      });

    await withServer(handler, async (client) => {
      await expect(client.listReleaseTags('o/r')).resolves.toEqual([]);
    });

    expect(handler).toHaveBeenCalledTimes(2);
  });

  const cutShort: RequestListener = (request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': '100',
    });
    response.write('[{"tag_na');
    setTimeout(() => request.socket.destroy(), 20);
  };

  const full: RequestListener = (_request, response) => {
    response
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end('[{"tag_name":"v5.0.0"}]');
  };

  it('sends the whole request again when the connection drops during the body', async () => {
    const handler = jest
      .fn<RequestListener>()
      .mockImplementationOnce(cutShort)
      .mockImplementation(full);

    await withServer(handler, async (client) => {
      await expect(client.listReleaseTags('o/r')).resolves.toEqual(['v5.0.0']);
    });

    expect(handler.mock.lastCall?.[0].headers['range']).toBeUndefined();
  });

  it('reports a body that keeps failing as a network error', async () => {
    await withServer(cutShort, async (client) => {
      await expect(client.listReleaseTags('o/r')).rejects.toThrow(
        /^Network error while attempting to fetch releases from o\/r: /,
      );
    });
  });

  it.each([429, 503])('honours Retry-After on a %s', async (status) => {
    const handler = jest
      .fn<RequestListener>()
      .mockImplementationOnce((_request, response) => {
        response.writeHead(status, { 'Retry-After': '1' }).end('slow down');
      })
      .mockImplementation(full);
    const started = Date.now();

    await withServer(handler, async (client) => {
      await expect(client.listReleaseTags('o/r')).resolves.toEqual(['v5.0.0']);
    });

    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('never waits for Retry-After beyond the time left for the call', async () => {
    const handler: RequestListener = (_request, response) => {
      response.writeHead(503, { 'Retry-After': '3600' }).end('busy');
    };
    const started = Date.now();

    await withServer(
      handler,
      async (client) => {
        await expect(client.listReleaseTags('o/r')).rejects.toThrow(
          /^Network error while attempting to fetch releases from o\/r: /,
        );
      },
      { timeoutMs: 300 },
    );

    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('gives up on a server that never answers once the time is up', async () => {
    const started = Date.now();

    await withServer(
      () => undefined,
      async (client) => {
        await expect(client.listReleaseTags('o/r')).rejects.toThrow(
          /^Network error while attempting to fetch releases from o\/r: /,
        );
      },
      { timeoutMs: 200 },
    );

    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('retries an attempt that stalls and keeps the overall deadline apart', async () => {
    const handler = jest
      .fn<RequestListener>()
      .mockImplementationOnce(() => undefined)
      .mockImplementation(full);

    await withServer(
      handler,
      async (client) => {
        await expect(client.listReleaseTags('o/r')).resolves.toEqual([
          'v5.0.0',
        ]);
      },
      { agent: new Agent({ headersTimeout: 100 }), minTimeout: 1 },
    );

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('follows a redirect to a renamed repository', async () => {
    const handler: RequestListener = (request, response) => {
      if (request.url?.startsWith('/repos/old/')) {
        response
          .writeHead(301, { Location: '/repos/new/r/releases?per_page=100' })
          .end();
      } else {
        full(request, response);
      }
    };

    await withServer(handler, async (client) => {
      await expect(client.listReleaseTags('old/r')).resolves.toEqual([
        'v5.0.0',
      ]);
    });
  });

  it('names the reason when a connection is refused, without the token', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    const port =
      address !== null && typeof address === 'object' ? address.port : 0;
    await new Promise((resolve) => probe.close(resolve));
    const client = new GitHubClient({
      token: 'SECRET-TOKEN',
      endpoint: `http://127.0.0.1:${port}`,
      agent: new Agent(),
      minTimeout: 1,
    });

    const error = await client.listReleaseTags('o/r').catch((e: unknown) => e);

    expect(messageOf(error)).toMatch(/ECONNREFUSED/);
    expect(messageOf(error)).not.toContain('SECRET-TOKEN');
  });

  it('sends requests through the proxy named in the environment', async () => {
    const backend = jest.fn<RequestListener>((_request, response) => {
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end('[{"tag_name":"v9.0.0"}]');
    });
    const server = createServer(backend);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    const proxy = await startTunnelProxy(
      address !== null && typeof address === 'object' ? address.port : 0,
    );
    const env = jest.replaceProperty(process, 'env', {
      ...process.env,
      HTTP_PROXY: proxy.url,
      http_proxy: proxy.url,
      NO_PROXY: '',
      no_proxy: '',
    });
    try {
      const client = new GitHubClient({ endpoint: 'http://github.invalid' });

      await expect(client.listReleaseTags('o/r')).resolves.toEqual(['v9.0.0']);
      expect(proxy.tunnelled).toEqual(['github.invalid:80']);
    } finally {
      env.restore();
      server.closeAllConnections();
      server.close();
      await proxy.close();
    }
  });
});
