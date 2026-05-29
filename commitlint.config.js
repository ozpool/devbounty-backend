/**
 * Conventional Commits enforcement (ENGINEERING.md §2).
 * Scopes are intentionally NOT enforced as an enum here — commitlint's
 * scope-enum would reject valid future scopes; the doc lists the allowed
 * set and review catches drift.
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
