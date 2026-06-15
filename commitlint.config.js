/**
 * Conventional Commits enforcement.
 * Scopes are intentionally not enforced as an enum — that would reject valid
 * future scopes; review catches scope drift instead.
 */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'header-max-length': [2, 'always', 72],
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'chore',
        'docs',
        'test',
        'refactor',
        'perf',
        'ci',
        'build',
        'style',
        'revert',
      ],
    ],
  },
};
