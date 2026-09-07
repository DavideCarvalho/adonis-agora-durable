import { ESLintUtils } from '@typescript-eslint/utils';

/** Shared rule creator — every rule's docs URL points at its README section. */
export const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/DavideCarvalho/adonis-durable/tree/main/packages/eslint-plugin#${name}`,
);
