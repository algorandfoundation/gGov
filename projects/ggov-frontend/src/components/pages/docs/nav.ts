/**
 * Canonical, ordered model of every docs page. The sidebar, the home "Start here"
 * contents (grouping + numbering), each page's header, and the "Next →" pager chain
 * are all DERIVED from this one array — to add or reorder a page, edit it here (plus
 * its <Route> in App.tsx) and everything else follows.
 */

export interface DocsPage {
  to: string
  /** Short label: shown in the sidebar and as the home-contents row title. */
  label: string
  /** Long title: the page H1 and the "Next →" pager title. */
  title: string
  /** Page header eyebrow; omitted for the home page, which renders its own header. */
  eyebrow?: string
  /** Sidebar group title ('' = ungrouped top items). */
  navGroup: string
  /** Home "Start here" group; omitted = not listed in the home contents. */
  homeGroup?: string
  /** One-line description for the home-contents row. */
  desc?: string
}

export const docsPages: DocsPage[] = [
  { to: '/docs', label: 'Home', title: 'Start here', navGroup: '' },
  { to: '/docs/getting-started', label: 'Getting started', title: 'Getting started', eyebrow: 'Get started', navGroup: '' },
  {
    to: '/docs/voting-power',
    label: 'How voting power works',
    title: 'How voting power works',
    eyebrow: 'Core concept',
    navGroup: 'Core concepts',
    homeGroup: 'Core concepts',
    desc: 'One block, one vote — where your power comes from.',
  },
  {
    to: '/docs/committees',
    label: 'Committees',
    title: 'Committees explained',
    eyebrow: 'Core concept',
    navGroup: 'Core concepts',
    homeGroup: 'Core concepts',
    desc: 'Who is eligible to vote in a given window, and why.',
  },
  {
    to: '/docs/periods',
    label: 'Voting periods',
    title: 'How a voting period works',
    eyebrow: 'Core concept',
    navGroup: 'Core concepts',
    homeGroup: 'Participating',
    desc: 'How periods open and close, and what topics are.',
  },
  {
    to: '/docs/delegation',
    label: 'Delegation',
    title: 'Delegation rules',
    eyebrow: 'Core concept',
    navGroup: 'Core concepts',
    homeGroup: 'Participating',
    desc: 'Hand your power to someone you trust, or vote for others.',
  },
  {
    to: '/docs/faq',
    label: 'FAQ & glossary',
    title: 'FAQ & glossary',
    eyebrow: 'Help',
    navGroup: 'Help',
    homeGroup: 'Help',
    desc: 'Common questions and plain-language definitions.',
  },
]

/** Group items by `key`, preserving the order in which each group first appears. */
function groupInOrder<T>(items: T[], key: (item: T) => string): { title: string; items: T[] }[] {
  const groups: { title: string; items: T[] }[] = []
  const byTitle = new Map<string, { title: string; items: T[] }>()
  for (const item of items) {
    const title = key(item)
    let group = byTitle.get(title)
    if (!group) {
      group = { title, items: [] }
      byTitle.set(title, group)
      groups.push(group)
    }
    group.items.push(item)
  }
  return groups
}

export interface DocsNavItem {
  to: string
  label: string
}

export interface DocsNavGroup {
  /** Empty title = ungrouped (no uppercase section label rendered). */
  title: string
  items: DocsNavItem[]
}

/** Sidebar nav, grouped by `navGroup`. Consumed by DocsLayout. */
export const docsNav: DocsNavGroup[] = groupInOrder(docsPages, (p) => p.navGroup).map((group) => ({
  title: group.title,
  items: group.items.map(({ to, label }) => ({ to, label })),
}))

export interface HomeContentsItem {
  num: string
  title: string
  desc: string
  to: string
}

export interface HomeContentsGroup {
  title: string
  items: HomeContentsItem[]
}

/**
 * Home "Start here" contents: every page that has a `homeGroup`, numbered 01.. in
 * reading order and then grouped. The row title uses the short `label`.
 */
export const homeContents: HomeContentsGroup[] = groupInOrder(
  docsPages
    .filter((p) => p.homeGroup)
    .map((p, idx) => ({
      group: p.homeGroup as string,
      item: { num: String(idx + 1).padStart(2, '0'), title: p.label, desc: p.desc ?? '', to: p.to },
    })),
  (x) => x.group,
).map((g) => ({ title: g.title, items: g.items.map((x) => x.item) }))

export function getDocsPage(to: string): DocsPage | undefined {
  return docsPages.find((p) => p.to === to)
}

/** The next page in reading order, or undefined for the last page (no pager). */
export function getNextDocsPage(to: string): DocsPage | undefined {
  const i = docsPages.findIndex((p) => p.to === to)
  return i >= 0 ? docsPages[i + 1] : undefined
}
