/**
 * @file Knip configuration that ignores this file and the semantic-release packages.
 */

export default {
  ignore: ['knip.config.ts'],
  ignoreDependencies: [/^@semantic-release\//],
};
