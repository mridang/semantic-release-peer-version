import { afterEach, describe, expect, it } from '@jest/globals';
import { inspect } from 'node:util';
import { MockAgent } from 'undici';
import { GitHubClient, request, type RequestOptions } from '../src/github.js';
import { messageOf } from '../src/utils/error.js';
import { startTunnelProxy } from './utils/proxy.js';
import { listen, startFaultyProxy } from './utils/server.js';

const API = 'https://api.github.com';
const PATH = '/repos/o/r/releases?per_page=100';

interface Reply {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

/**
 * A mock agent that answers the releases request with the given replies in
 * order, the last one repeating. Nothing else is reachable.
 * @param replies - What to answer with.
 * @returns The agent, and the headers of each request it received.
 */
const mockReleases = (
  ...replies: readonly Reply[]
): { agent: MockAgent; seen: Record<string, unknown>[] } => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const seen: Record<string, unknown>[] = [];
  const pool = agent.get(API);
  replies.forEach((reply, index) => {
    const scope = pool
      .intercept({ path: PATH, method: 'GET' })
      .reply((options) => {
        seen.push({ ...(options.headers as Record<string, unknown>) });
        return {
          statusCode: reply.status ?? 200,
          data:
            typeof reply.body === 'string'
              ? reply.body
              : JSON.stringify(reply.body ?? []),
          responseOptions: { headers: reply.headers ?? {} },
        };
      });
    if (index === replies.length - 1) {
      scope.persist();
    } else {
      scope.times(1);
    }
  });
  return { agent, seen };
};

const failure = async (client: GitHubClient, repo = 'o/r'): Promise<string> =>
  client.listReleaseTags(repo).then(
    () => 'resolved',
    (error: unknown) => messageOf(error),
  );

describe('GitHubClient.listReleaseTags', () => {
  it('lists the tag names, asking for the latest 100 releases', async () => {
    const { agent, seen } = mockReleases({
      body: [{ tag_name: 'v1.0.0' }, { tag_name: 'v2.0.0' }],
    });

    await expect(
      new GitHubClient({ agent }).listReleaseTags('o/r'),
    ).resolves.toEqual(['v1.0.0', 'v2.0.0']);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      accept: 'application/vnd.github+json',
      'user-agent': 'semantic-release-peer-version',
      'x-github-api-version': '2022-11-28',
    });
  });

  it('sends the token as a bearer credential when one is given', async () => {
    const { agent, seen } = mockReleases({});

    await new GitHubClient({ token: 'TOKEN', agent }).listReleaseTags('o/r');

    expect(seen[0]?.['authorization']).toBe('Bearer TOKEN');
  });

  it.each([
    [404, undefined, /The repository was not found or it is private/],
    [404, 'TOKEN', /does not have 'repo' scope access to it/],
    [401, 'TOKEN', /Authentication failed/],
    [403, 'TOKEN', /Access forbidden. The provided GitHub token might lack/],
    [403, undefined, /Access forbidden. No GitHub token was provided/],
  ])('explains HTTP %s (token: %s)', async (status, token, message) => {
    const { agent } = mockReleases({ status, body: {} });

    const text = await failure(new GitHubClient({ token, agent }));

    expect(text).toMatch(
      new RegExp(
        String.raw`^Failed to fetch releases from o/r \(${status}\)\. `,
      ),
    );
    expect(text).toMatch(message);
  });

  it('explains throttling and server errors once the retries have run out', async () => {
    const texts = await Promise.all(
      [
        [429, undefined],
        [429, 'TOKEN'],
        [500, undefined],
      ].map(async ([status, token]) => {
        const { agent, seen } = mockReleases({ status: Number(status) });
        const text = await failure(
          new GitHubClient({ token: token as string | undefined, agent }),
        );
        return { text, calls: seen.length };
      }),
    );

    expect(texts.map((t) => t.calls)).toEqual([4, 4, 4]);
    expect(texts[0]?.text).toMatch(/throttling.*Providing a GitHub token/);
    expect(texts[1]?.text).toMatch(/throttling.*Try again later/);
    expect(texts[2]?.text).toMatch(/Please check repository URL/);
  }, 20_000);

  it.each([
    ['an object', { tag_name: 'v1.0.0' }],
    ['a list with an item that has no tag', [{ tag_name: 'v1.0.0' }, {}]],
    ['a list with a non-string tag', [{ tag_name: 1 }]],
    ['a list of non-objects', ['v1.0.0']],
    ['text that is not JSON', 'not json'],
    ['an empty body', ''],
  ])('rejects %s as an invalid response', async (_name, body) => {
    const { agent } = mockReleases({ body });

    expect(await failure(new GitHubClient({ agent }))).toMatch(
      /^Invalid response format received from GitHub API when fetching releases for o\/r\./,
    );
  });

  it('refuses a repo that is not owner/name without sending anything', async () => {
    const { agent, seen } = mockReleases({});
    const client = new GitHubClient({ token: 'TOKEN', agent });

    for (const repo of ['o/r?per_page=1', 'o/r/../../x', 'o']) {
      await expect(client.listReleaseTags(repo)).rejects.toMatchObject({
        code: 'EINVALIDREPO',
      });
    }
    expect(seen).toHaveLength(0);
  });

  it('retries a server error and returns the later success', async () => {
    const { agent, seen } = mockReleases(
      { status: 503, body: 'busy' },
      { body: [{ tag_name: 'v3.0.0' }] },
    );

    await expect(
      new GitHubClient({ agent }).listReleaseTags('o/r'),
    ).resolves.toEqual(['v3.0.0']);
    expect(seen).toHaveLength(2);
  });

  it('does not retry a client error', async () => {
    const { agent, seen } = mockReleases({ status: 404, body: {} });

    await failure(new GitHubClient({ agent }));

    expect(seen).toHaveLength(1);
  });
});

describe('GitHubClient failure messages', () => {
  it('names the rate limit and does not blame a token that was not sent', async () => {
    const { agent } = mockReleases({
      status: 403,
      body: { message: 'API rate limit exceeded for 1.2.3.4.' },
    });

    const text = await failure(new GitHubClient({ agent }));

    expect(text).toContain('No GitHub token was provided');
    expect(text).not.toContain('might lack required scopes');
    expect(text).toMatch(
      /GitHub said: API rate limit exceeded for 1\.2\.3\.4\.$/,
    );
  });

  it('does not suggest a token when one was used', async () => {
    const { agent } = mockReleases({
      status: 403,
      body: { message: 'API rate limit exceeded' },
    });

    expect(
      await failure(new GitHubClient({ token: 'TOKEN', agent })),
    ).toContain('rate limit was exceeded. Try again later.');
  });

  it("cuts GitHub's own message short", async () => {
    const { agent } = mockReleases({
      status: 404,
      body: { message: 'x'.repeat(100_000) },
    });

    const text = await failure(new GitHubClient({ agent }));

    expect(text.endsWith(`${'x'.repeat(2000)}... (truncated)`)).toBe(true);
    expect(text.length).toBeLessThan(2600);
  });

  it('keeps the token out of an error the server echoes', async () => {
    const { agent } = mockReleases({
      status: 404,
      body: { message: 'no such repo for Bearer SECRET-TOKEN' },
    });

    const text = await failure(
      new GitHubClient({ token: 'SECRET-TOKEN', agent }),
    );

    expect(text).toContain('GitHub said: no such repo for Bearer [redacted]');
    expect(text).not.toContain('SECRET-TOKEN');
  });

  it('keeps a token that is not a legal header value out of the error', async () => {
    // The header is refused before any connection is made.
    const client = new GitHubClient({ token: 'SEC RET\nX: y' });

    const text = await failure(client);

    expect(text).toMatch(/^Network error calling api\.github\.com/);
    expect(text).not.toContain('SEC RET');
  });

  it('reports a redirect it does not follow, without the query', async () => {
    const { agent } = mockReleases({
      status: 301,
      headers: {
        location: 'http://api.github.com/repos/n/r/releases?access=1',
      },
    });

    const error = await new GitHubClient({ token: 'T', agent })
      .listReleaseTags('o/r')
      .catch((error_: unknown) => error_);

    expect(error).toMatchObject({ code: 'EREDIRECT' });
    expect(messageOf(error)).toContain(
      'answered 301 with a redirect to http://api.github.com/repos/n/r/releases, which is not followed',
    );
    expect(messageOf(error)).not.toContain('access=1');
  });

  it('refuses a malformed proxy setting without printing it', async () => {
    const saved = { ...process.env };
    process.env['HTTPS_PROXY'] = 'http://user:PW-SECRET@bad host:3128';
    try {
      const error = await new GitHubClient({})
        .listReleaseTags('o/r')
        .catch((error_: unknown) => error_);

      expect(error).toMatchObject({ code: 'EPROXY' });
      const shown = [
        String(error),
        inspect(error, { depth: 10, showHidden: true }),
        JSON.stringify(error, Object.getOwnPropertyNames(error)),
      ].join('\n');
      expect(shown).not.toContain('PW-SECRET');
      expect(shown).toContain('HTTPS_PROXY');
    } finally {
      process.env = saved;
    }
  });
});

describe('request over a real socket', () => {
  const stops: (() => Promise<void>)[] = [];
  const saved = { ...process.env };

  const serve = async (
    handler: Parameters<typeof listen>[0],
  ): ReturnType<typeof listen> => {
    const server = await listen(handler);
    stops.push(server.close);
    return server;
  };

  const through = (proxyUrl: string, noProxy = ''): void => {
    process.env['HTTP_PROXY'] = proxyUrl;
    process.env['NO_PROXY'] = noProxy;
    delete process.env['http_proxy'];
    delete process.env['no_proxy'];
  };

  afterEach(async () => {
    process.env = { ...saved };
    await Promise.all(stops.splice(0).map((stop) => stop()));
  });

  const fast: RequestOptions = { minTimeout: 1 };

  it('sends the default headers once, whatever the case of an override', async () => {
    const headers: unknown[] = [];
    const { url } = await serve((req, res) => {
      headers.push(req.headers);
      res.end('{}');
    });

    await request(
      `${url}/a`,
      { headers: { Accept: 'text/plain', 'X-Extra': '1' } },
      fast,
    );

    expect(headers[0]).toMatchObject({
      accept: 'text/plain',
      'user-agent': 'semantic-release-peer-version',
      'x-extra': '1',
    });
  });

  it('honours Retry-After before retrying', async () => {
    const { url, seen } = await serve((_req, res) => {
      const first = seen.length === 1;
      res.writeHead(first ? 503 : 200, first ? { 'Retry-After': '1' } : {});
      res.end(first ? 'busy' : '{"ok":1}');
    });
    const started = Date.now();

    const result = await request(`${url}/a`, {}, { retries: 1 });

    expect(result).toMatchObject({ status: 200, body: { ok: 1 } });
    expect(seen).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('caps a long Retry-After at a quarter of the deadline', async () => {
    const { url, seen } = await serve((_req, res) => {
      const first = seen.length === 1;
      res.writeHead(first ? 429 : 200, first ? { 'Retry-After': '20' } : {});
      res.end('{}');
    });
    const started = Date.now();

    await request(`${url}/a`, {}, { retries: 1, deadlineMs: 4000 });

    const took = Date.now() - started;
    expect(seen).toHaveLength(2);
    expect(took).toBeGreaterThanOrEqual(900);
    expect(took).toBeLessThan(3000);
  });

  it('falls back to back-off for a Retry-After date in the past', async () => {
    const { url, seen } = await serve((_req, res) => {
      const first = seen.length === 1;
      res.writeHead(
        first ? 503 : 200,
        first ? { 'Retry-After': 'Wed, 21 Oct 2015 07:28:00 GMT' } : {},
      );
      res.end('{}');
    });

    await request(`${url}/a`, {}, { retries: 1, minTimeout: 1 });

    expect(seen).toHaveLength(2);
  });

  it('cancels a wait for the next attempt when the deadline passes', async () => {
    const timers = (): number =>
      process.getActiveResourcesInfo().filter((name) => name === 'Timeout')
        .length;
    const { url } = await serve((_req, res) => {
      res.writeHead(503, { 'Retry-After': '3600' }).end('busy');
    });
    const before = timers();

    await expect(
      request(`${url}/a`, {}, { retries: 10, deadlineMs: 400 }),
    ).rejects.toThrow(/Network error calling 127\.0\.0\.1/);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(timers()).toBeLessThanOrEqual(before);
  });

  it('retries an attempt that stalls, as a dropped connection is', async () => {
    const { url, seen } = await serve((_req, res) => {
      if (seen.length > 1) {
        res.end('{"ok":1}');
      }
    });

    const result = await request(
      `${url}/a`,
      {},
      { retries: 1, attemptTimeoutMs: 1000, minTimeout: 1 },
    );

    expect(result).toMatchObject({ status: 200, body: { ok: 1 } });
    expect(seen).toHaveLength(2);
  }, 15_000);

  it('gives up with one request per attempt when every attempt stalls', async () => {
    const { url, seen } = await serve(() => undefined);

    await expect(
      request(
        `${url}/a`,
        {},
        { retries: 1, attemptTimeoutMs: 1000, minTimeout: 1 },
      ),
    ).rejects.toThrow(/Network error calling 127\.0\.0\.1/);
    expect(seen).toHaveLength(2);
  }, 15_000);

  it('stops at the deadline', async () => {
    const { url } = await serve(() => undefined);
    const started = Date.now();

    await expect(request(`${url}/a`, {}, { deadlineMs: 1000 })).rejects.toThrow(
      /aborted due to timeout/,
    );
    expect(Date.now() - started).toBeLessThan(2000);
  }, 15_000);

  it('sends exactly retries + 1 whole requests when the body is always cut short', async () => {
    const { url, seen } = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Length': '100' });
      res.write('{"par');
      setTimeout(() => res.socket?.destroy(), 10);
    });

    await expect(
      request(`${url}/a`, {}, { retries: 2, minTimeout: 1 }),
    ).rejects.toThrow(/other side closed/);
    expect(seen).toEqual(['GET /a', 'GET /a', 'GET /a']);
  }, 15_000);

  it('sends the whole request again, never a Range resume, when the body is cut once', async () => {
    const { url, seen } = await serve((_req, res) => {
      if (seen.length === 1) {
        res.writeHead(200, { 'Content-Length': '100' });
        res.write('{"par');
        setTimeout(() => res.socket?.destroy(), 10);
        return;
      }
      res.end('{"ok":1}');
    });

    const result = await request(`${url}/a`, {}, { retries: 2, minTimeout: 1 });

    expect(result).toMatchObject({ status: 200, body: { ok: 1 } });
    expect(seen).toEqual(['GET /a', 'GET /a']);
  });

  it('does not read, or repeat a request for, a body larger than the cap', async () => {
    const { url, seen } = await serve((_req, res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(33 * 1024 * 1024, 97));
    });

    await expect(
      request(`${url}/a`, {}, { retries: 2, minTimeout: 1 }),
    ).rejects.toThrow(/Network error calling 127\.0\.0\.1/);
    expect(seen).toHaveLength(1);
  });

  it('names the code when a closed local port refuses the connection, without leaking the URL', async () => {
    const server = await listen(() => undefined);
    await server.close();

    const error = await request(
      `http://localhost:${server.port}/a?token=SECRET`,
      { headers: { Authorization: 'Bearer SECRET' } },
      fast,
    ).catch((error_: unknown) => error_);

    expect(String(error)).toContain('ECONNREFUSED');
    expect(String(error)).not.toContain('SECRET');
  });

  it('goes through the proxy named by the environment', async () => {
    const target = await serve((_req, res) => res.end('{"direct":1}'));
    const proxy = await startTunnelProxy(target.port);
    stops.push(proxy.close);
    through(proxy.url);

    const result = await request('http://something.invalid/a', {});

    expect(result.body).toEqual({ direct: 1 });
    expect(proxy.tunnelled).toEqual(['something.invalid:80']);
  });

  it('skips the proxy for hosts listed in NO_PROXY', async () => {
    const target = await serve((_req, res) => res.end('{"direct":1}'));
    const proxy = await startTunnelProxy(target.port);
    stops.push(proxy.close);
    through(proxy.url, '127.0.0.1');

    const result = await request(`${target.url}/a`, {});

    expect(result.body).toEqual({ direct: 1 });
    expect(proxy.tunnelled).toHaveLength(0);
  });

  it.each(['reset', 'stall'] as const)(
    'gives up at the deadline when the proxy accepts CONNECT and then %ss, and stays idle',
    async (mode) => {
      const proxy = await startFaultyProxy(mode);
      stops.push(proxy.close);
      through(proxy.url);
      const started = Date.now();

      await expect(
        request(
          'http://something.invalid/a',
          {},
          { retries: 1, deadlineMs: 1500, minTimeout: 1 },
        ),
      ).rejects.toThrow(/Network error calling something\.invalid/);

      expect(Date.now() - started).toBeLessThan(4000);
      const connects = proxy.connects();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(proxy.connects()).toBe(connects);
    },
    15_000,
  );

  describe('redirects', () => {
    it('are not followed unless asked for, and the target is shown without its query', async () => {
      const { url, seen } = await serve((_req, res) => {
        res.writeHead(302, { Location: '/elsewhere?token=SECRET' });
        res.end();
      });

      const result = await request(`${url}/a`, {});

      expect(result).toMatchObject({
        status: 302,
        ok: false,
        location: `${url}/elsewhere`,
      });
      expect(JSON.stringify(result)).not.toContain('SECRET');
      expect(seen).toEqual(['GET /a']);
    });

    it('are followed on the same origin when asked for, credentials included', async () => {
      const headers: unknown[] = [];
      const { url, seen } = await serve((req, res) => {
        headers.push(req.headers['authorization']);
        if (seen.length === 1) {
          res.writeHead(301, { Location: '/b?x=1' }).end();
          return;
        }
        res.end('{"ok":1}');
      });

      const result = await request(
        `${url}/a`,
        { headers: { Authorization: 'Bearer T' } },
        { followRedirects: true },
      );

      expect(result).toMatchObject({ status: 200, body: { ok: 1 } });
      expect(seen).toEqual(['GET /a', 'GET /b?x=1']);
      expect(headers).toEqual(['Bearer T', 'Bearer T']);
    });

    it('are not followed to another origin, so the credentials stay put', async () => {
      const other = await serve((_req, res) => res.end('{"leak":1}'));
      const { url } = await serve((_req, res) => {
        res.writeHead(302, { Location: `${other.url}/x?token=SECRET` }).end();
      });

      const result = await request(
        `${url}/a`,
        { headers: { Authorization: 'Bearer T' } },
        { followRedirects: true },
      );

      expect(result).toMatchObject({
        status: 302,
        location: `${other.url}/x`,
      });
      expect(other.seen).toHaveLength(0);
    });

    it('are not followed from https to http', async () => {
      const agent = new MockAgent();
      agent.disableNetConnect();
      agent
        .get('https://x.test')
        .intercept({ path: '/a', method: 'GET' })
        .reply(301, '', { headers: { location: 'http://x.test/b?access=1' } });

      const result = await request(
        'https://x.test/a',
        {},
        { agent, followRedirects: true },
      );

      expect(result).toMatchObject({
        status: 301,
        location: 'http://x.test/b',
      });
    });

    it('stop after three hops and report the last redirect', async () => {
      const { url, seen } = await serve((_req, res) => {
        res.writeHead(301, { Location: '/again' }).end();
      });

      const result = await request(`${url}/a`, {}, { followRedirects: true });

      expect(result).toMatchObject({ status: 301, location: `${url}/again` });
      expect(seen).toHaveLength(4);
    });

    it('are not followed for a POST', async () => {
      const { url, seen } = await serve((_req, res) => {
        res.writeHead(307, { Location: '/b' }).end();
      });

      const result = await request(
        `${url}/a`,
        { method: 'POST', body: 'a=1' },
        { followRedirects: true },
      );

      expect(result.status).toBe(307);
      expect(seen).toEqual(['POST /a']);
    });

    it('are not followed without a usable location', async () => {
      const { url, seen } = await serve((_req, res) => {
        res.writeHead(302).end();
      });

      const result = await request(`${url}/a`, {}, { followRedirects: true });

      expect(result).toMatchObject({ status: 302 });
      expect(result.location).toBeUndefined();
      expect(seen).toHaveLength(1);
    });
  });
});

describe('request with a mock agent', () => {
  const URL_A = 'https://x.test/a';
  const via = (replies: readonly [number, string][]): MockAgent => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get('https://x.test');
    replies.forEach(([status, data], index) => {
      const scope = pool
        .intercept({ path: '/a', method: 'GET' })
        .reply(status, data);
      if (index === replies.length - 1) {
        scope.persist();
      } else {
        scope.times(1);
      }
    });
    return agent;
  };

  it('decodes a JSON body, falls back to text, and returns undefined for none', async () => {
    expect(
      await request(URL_A, {}, { agent: via([[200, '{"ok":1}']]) }),
    ).toEqual({ status: 200, ok: true, body: { ok: 1 } });
    expect(
      await request(URL_A, {}, { agent: via([[502, '<html>bad</html>']]) }),
    ).toMatchObject({ status: 502, ok: false, body: '<html>bad</html>' });
    expect(
      (await request(URL_A, {}, { agent: via([[200, '']]) })).body,
    ).toBeUndefined();
  });

  it('does not retry unless asked to', async () => {
    expect(
      (await request(URL_A, {}, { agent: via([[503, 'x']]) })).status,
    ).toBe(503);
  });

  it('returns the last response once the retries are used up', async () => {
    const result = await request(
      URL_A,
      {},
      { agent: via([[503, 'down']]), retries: 2, minTimeout: 1 },
    );

    expect(result).toMatchObject({ status: 503, ok: false, body: 'down' });
  });

  it('never retries a POST without retryPost, whatever retries says', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get('https://x.test')
      .intercept({ path: '/a', method: 'POST' })
      .reply(503, 'x')
      .persist();

    const result = await request(
      URL_A,
      { method: 'POST' },
      { agent, retries: 3, minTimeout: 1 },
    );

    expect(result.status).toBe(503);
  });
});
