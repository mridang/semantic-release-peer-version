# Semantic Release - Upstream Major Version Blocker

A [semantic-release](https://github.com/semantic-release/semantic-release)
plugin to prevent a new major version release if a specified upstream GitHub
repository does not have a matching or higher major version tag on a given
branch.

This plugin helps ensure that your project's major versions do not get ahead of
a critical upstream dependency, maintaining versioning harmony and preventing
accidental releases of incompatible software.

### Why?

When working with microservices, client libraries, or any project that has a
critical upstream dependency, it's often important to ensure that your project's
major versions align with or do not significantly outpace the major versions of
that dependency. Releasing a new major version of your software (e.g., v3.0.0)
that depends on an older major version of an upstream service (e.g., v2.x.x) can
lead to:

- **Integration Issues:** Your new major version might be incompatible with the
  currently deployed upstream service if it expects features or breaking
  changes from a newer, unreleased upstream major version.
- **User Confusion:** Users might upgrade your package expecting it to work
  with the latest stable upstream, only to find it's designed for a future,
  unreleased upstream version.
- **Deployment Blockers:** You might intend for your v3.0.0 to work with the
  upstream's upcoming v3.0.0, but if your release pipeline is faster, your
  v3.0.0 could be released prematurely.

This plugin provides a safeguard by checking a designated upstream repository and
branch. If your automated release process (via semantic-release) determines a
major bump is due, this plugin will first verify that the upstream dependency
has already reached that major version (or higher) on its specified branch. If
not, the release is blocked, preventing these potential issues.

## Installation

Install using NPM by using the following command:

```sh
npm install --save @mridang/semantic-release
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
  branches: ['main', 'next'], // Your release branches
  plugins: [
    '@semantic-release/commit-analyzer', // Must come first to determine release type
    [
      '@mridang/semantic-release-upstream-version-blocker', // Replace with your actual package name
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

Ensure you replace `@mridang/semantic-release-upstream-version-blocker` with the
actual published name of your package if it's different.

## Known Issues

- **GitHub API Rate Limiting:** The plugin makes requests to the GitHub API to
  fetch tags and compare commits. Unauthenticated requests are subject to
  stricter rate limits. For frequent use or in CI environments, providing a
  `githubToken` with appropriate permissions is highly recommended to avoid
  being rate-limited.
- **Upstream Repository Tagging:** This plugin relies on the upstream
  repository using [Semantic Versioning](https://semver.org/) for its tags and
  these tags being present on the specified branch. If the upstream repository
  does not follow semver for tags or uses a different tagging strategy on the
  target branch, the plugin may not be able to determine the correct major
  version cap.
- **Tag Pagination:** The plugin currently fetches up to the 100 most recent
  tags from the upstream repository. If the relevant semver tag on the branch
  is older than the 100 most recent tags, it might not be found.
- **Token Permissions:** If a `githubToken` is provided, it must have
  sufficient read permissions for the upstream repository (e.g., `repo` scope
  for private repositories, or public access for public repositories) to list
  tags and compare commits.

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
