/** Members per page when a summarized fan's members are listed. */
export const FAN_PAGE_SIZE = 100;

/**
 * The pages holding rows `first`..`last` of a virtualized member list: the only pages it fetches.
 * With no rows in view (the total is not known yet) it asks for page 0, which reports the total.
 */
export function fanPagesInView(
  first: number | undefined,
  last: number | undefined,
  pageSize = FAN_PAGE_SIZE,
): number[] {
  if (first === undefined || last === undefined) return [0];
  const pages: number[] = [];
  for (let page = Math.floor(first / pageSize); page <= Math.floor(last / pageSize); page += 1) {
    pages.push(page);
  }
  return pages;
}
