import type { IconName } from '~/components/ui/icons'

export interface NavItem {
  /** Stable id, used for tests and the active state. */
  slug: string
  label: string
  to: string
  icon: IconName
  /** Route-name prefix that keeps this item highlighted on child routes. */
  match?: string
}

export interface NavGroup {
  slug: string
  label: string
  items: NavItem[]
}

/** Side-menu structure. Same groups, labels and links as before the rebuild. */
export const navGroups: NavGroup[] = [
  {
    slug: 'test-platform',
    label: 'Test Platform',
    items: [
      { slug: 'platform:home', label: 'Home', to: '/', icon: 'home', match: 'platform.home' },
      {
        slug: 'platform:tests',
        label: 'Tests',
        to: '/tests',
        icon: 'list-check',
        match: 'platform.tests',
      },
      {
        slug: 'platform:test-data',
        label: 'Test Data',
        to: '/test-data',
        icon: 'database',
        match: 'platform.test-data',
      },
      {
        slug: 'platform:suites',
        label: 'Suites',
        to: '/suites',
        icon: 'stack-2',
        match: 'platform.suites',
      },
      {
        slug: 'platform:suite-runs',
        label: 'Suite Runs',
        to: '/suite-runs',
        icon: 'player-track-next',
        match: 'platform.suite-runs',
      },
      {
        slug: 'platform:runs',
        label: 'Runs',
        to: '/runs',
        icon: 'player-play',
        match: 'platform.runs',
      },
      {
        slug: 'platform:references',
        label: 'References',
        to: '/references',
        icon: 'book',
        match: 'platform.references',
      },
      {
        slug: 'platform:health',
        label: 'API Status',
        to: '/system/health',
        icon: 'heart-rate-monitor',
        match: 'platform.health',
      },
    ],
  },
  {
    slug: 'helpers',
    label: 'Helpers',
    items: [
      {
        slug: 'platform:mock-api',
        label: 'Mock API',
        to: '/mock-api',
        icon: 'api',
        match: 'platform.mock-api',
      },
    ],
  },
  {
    slug: 'configuration',
    label: 'Configuration',
    items: [
      {
        slug: 'platform:environments',
        label: 'Environments',
        to: '/environments',
        icon: 'server',
        match: 'platform.environments',
      },
      {
        slug: 'platform:secrets',
        label: 'Secrets',
        to: '/secrets',
        icon: 'key',
        match: 'platform.secrets',
      },
    ],
  },
]

export const allNavItems: NavItem[] = navGroups.flatMap((g) => g.items)

/** True when `routeName` is the item's route or one of its children (`name.new`, `name.edit`...). */
export function isNavActive(item: NavItem, routeName: string | symbol | null | undefined): boolean {
  if (typeof routeName !== 'string' || !item.match) return false
  return routeName === item.match || routeName.startsWith(`${item.match}.`)
}
