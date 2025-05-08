# Semantic Release - Upstream Major Version Blocker

A [semantic-release](https://github.com/semantic-release/semantic-release)
plugin to prevent a new major version release if a specified upstream GitHub
repository does not have a matching or higher major version SemVer tag on a
given branch.

This plugin helps ensure that your project's major versions do not prematurely
get ahead of a critical upstream dependency, maintaining versioning harmony and
preventing accidental releases of software that may rely on unreleased
upstream features.

### Why?

When your project (e.g., a client library, a microservice component) has a
critical upstream dependency, its major version changes are often closely
tied to the major versions of that dependency. For instance, you might be
developing `your-project v2.1.0` which is compatible with
`upstream-dependency v2.x.x`. If `your-project` is due for a major update
to `v3.0.0`, this new version is likely intended to align with, or require
features from, `upstream-dependency v3.0.0` (or newer).

Releasing `your-project v3.0.0` *before* `upstream-dependency` has itself
reached at least major version 3 (e.g., `v3.0.0`) on its relevant branch
can lead to several problems:

-   **Integration Issues:** Your new `v3.0.0` might be incompatible with the
	currently deployed `v2.x.x` of the upstream service because it expects
	features or breaking changes from the (as yet unreleased) upstream
	`v3.0.0`.
-   **User Confusion:** Users might upgrade `your-project` to `v3.0.0` expecting
	it to work with the latest stable version of the upstream dependency,
	only to discover it's designed for a future, unreleased upstream
	version.
-   **Deployment Blockers:** You might intend for `your-project v3.0.0` to be
	released in tandem with `upstream-dependency v3.0.0`. However, if your
	project's release pipeline triggers first, your `v3.0.0` could be
	published prematurely, leading to a version that doesn't work
	correctly in the current ecosystem.

This plugin provides a safeguard by checking a designated upstream GitHub
repository and a specific branch within it. If your automated release process
(via semantic-release) determines that a major version bump is due for your
project, this plugin will first verify that the upstream dependency has
already published a release tag indicating that major version (or a higher
one) on its specified branch. If this condition is not met, the release of
your project is blocked, preventing these potential issues.

## Installation

Install using NPM by using the following command:

```sh
npm install --save @mridang/semantic-release-peer-version
```

## Usage

To use this plugin, add it to your semantic-release configuration file (e.g.,
`.releaserc.js`, `release.config.js`, or in your `package.json`).

The plugin should typically be placed _before_ the `@semantic-release/npm` or
`@semantic-release/github` plugins in the `plugins` array, as it needs to run
its checks in the `verifyConditions` and `analyzeCommits` steps.

**Example Configuration (`.releaserc.js`):**

```javascript
module.exports = {
  branches: ['main', 'next'],
  plugins: [
    '@semantic-release/commit-analyzer', // Must come first to determine release type
    [
      '@mridang/semantic-release-peer-version',
      {
        repo: 'owner/repo',
        // Optional: GitHub token for private repos or to avoid rate limiting
        // Defaults to process.env.GITHUB_TOKEN || process.env.GH_TOKEN
        // githubToken: process.env.UPSTREAM_GITHUB_TOKEN
      },
    ],
    '@semantic-release/release-notes-generator',
    '@semantic-release/changelog',
    '@semantic-release/npm', // If publishing to npm
    '@semantic-release/github', // For creating GitHub releases and comments
    '@semantic-release/git', // To commit package.json, CHANGELOG.md, etc.
  ],
};
```

## Known Issues

-   **GitHub API Rate Limiting:** The plugin interacts with the GitHub API to
	fetch release information (which includes tags) and potentially compare
	commits. Unauthenticated API requests are subject to stricter rate limits.
	To prevent disruptions, especially in CI environments or with frequent
	usage, providing a `githubToken` is highly recommended. This enables the
	more lenient rate limits associated with authenticated requests.
-   **Upstream Repository Tagging and Versioning:** This plugin relies on the
	upstream repository adhering to [Semantic Versioning](https://semver.org/)
	for its release tags. These SemVer tags should be associated with
	published releases on the repository. If the upstream repository does not
	consistently use SemVer for its release tags, the plugin may be unable to
	accurately determine versioning information, such as a major version cap.
-   **Release Pagination:** The plugin currently fetches data for up to the 100
	most recent releases from the upstream repository to identify relevant
	SemVer tags. If the specific SemVer-tagged release crucial for the
	plugin's logic (e.g., for version capping or comparison) is older than
	these 100 most recent releases, it might not be detected.
-   **Token Permissions:** When a `githubToken` is provided, it must have
	sufficient permissions to access the upstream repository's data. For
	private repositories, the `repo` scope (granting full control of private
	repositories) is typically required. For public repositories, while a token
	might not be strictly necessary for basic read access, providing one for
	authenticated requests (which helps with rate limits) means the token
	must still have adequate permissions to read repository content, list
	releases, and compare commits if these operations are performed by the
	plugin.

## Useful links

- **[Semantic Release](https://github.com/semantic-release/semantic-release):**
  The core automated version management and package publishing tool.
- **[Semantic Versioning (SemVer)](https://semver.org/):** The versioning
  specification that semantic-release adheres to.

## Contributing

If you have suggestions for how this app could be improved, or
want to report a bug, open an issue - we'd love all and any
contributions.

## License

Apache License 2.0 © 2024 Mridang Agarwalla
