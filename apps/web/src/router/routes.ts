import type { RouteRecordRaw } from 'vue-router'

export const allRoutes: RouteRecordRaw[] = [
  {
    path: '',
    component: () => import('~/layouts/DefaultLayout.vue'),
    children: [
      {
        // An empty child path is the parent's own URL ('/'); an absolute '/' child is not matched.
        path: '',
        name: 'platform.home',
        meta: { title: 'Home' },
        component: () => import('~/views/platform/home/index.vue'),
      },
      {
        path: '/environments',
        name: 'platform.environments',
        meta: { title: 'Environments' },
        component: () => import('~/views/platform/environments/index.vue'),
      },
      {
        path: '/environments/new',
        name: 'platform.environments.new',
        meta: { title: 'New Environment' },
        component: () => import('~/views/platform/environments/EnvironmentEditorView.vue'),
      },
      {
        path: '/environments/:id',
        name: 'platform.environments.edit',
        meta: { title: 'Edit Environment' },
        component: () => import('~/views/platform/environments/EnvironmentEditorView.vue'),
      },
      {
        path: '/secrets',
        name: 'platform.secrets',
        meta: { title: 'Secrets' },
        component: () => import('~/views/platform/secrets/index.vue'),
      },
      {
        path: '/tests',
        name: 'platform.tests',
        meta: { title: 'Tests' },
        component: () => import('~/views/platform/tests/index.vue'),
      },
      {
        path: '/tests/new',
        name: 'platform.tests.new',
        meta: { title: 'New Test' },
        component: () => import('~/views/platform/tests/TestEditorView.vue'),
      },
      {
        path: '/tests/:id',
        name: 'platform.tests.edit',
        meta: { title: 'Edit Test' },
        component: () => import('~/views/platform/tests/TestEditorView.vue'),
      },
      {
        path: '/test-data',
        name: 'platform.test-data',
        meta: { title: 'Test Data' },
        component: () => import('~/views/platform/test-data/index.vue'),
      },
      {
        path: '/test-data/new',
        name: 'platform.test-data.new',
        meta: { title: 'New Test Data' },
        component: () => import('~/views/platform/test-data/TestDataEditorView.vue'),
      },
      {
        path: '/test-data/:id',
        name: 'platform.test-data.edit',
        meta: { title: 'Edit Test Data' },
        component: () => import('~/views/platform/test-data/TestDataEditorView.vue'),
      },
      {
        path: '/mock-api',
        name: 'platform.mock-api',
        meta: { title: 'Mock API' },
        component: () => import('~/views/platform/mock-api/index.vue'),
      },
      {
        path: '/mock-api/new',
        name: 'platform.mock-api.new',
        meta: { title: 'New Mock API setup' },
        component: () => import('~/views/platform/mock-api/MockSetupEditorView.vue'),
      },
      {
        path: '/mock-api/:id',
        name: 'platform.mock-api.edit',
        meta: { title: 'Edit Mock API setup' },
        component: () => import('~/views/platform/mock-api/MockSetupEditorView.vue'),
      },
      {
        path: '/suites',
        name: 'platform.suites',
        meta: { title: 'Suites' },
        component: () => import('~/views/platform/suites/index.vue'),
      },
      {
        path: '/suites/new',
        name: 'platform.suites.new',
        meta: { title: 'New Suite' },
        component: () => import('~/views/platform/suites/SuiteEditorView.vue'),
      },
      {
        path: '/suites/:id',
        name: 'platform.suites.edit',
        meta: { title: 'Edit Suite' },
        component: () => import('~/views/platform/suites/SuiteEditorView.vue'),
      },
      {
        path: '/suite-runs',
        name: 'platform.suite-runs',
        meta: { title: 'Suite Runs' },
        component: () => import('~/views/platform/suites/SuiteRunsView.vue'),
      },
      {
        path: '/suite-runs/new',
        name: 'platform.suite-runs.new',
        meta: { title: 'Run a Suite' },
        component: () => import('~/views/platform/suites/SuiteRunLaunchView.vue'),
      },
      {
        path: '/suite-runs/:id',
        name: 'platform.suite-runs.detail',
        meta: { title: 'Suite Run' },
        component: () => import('~/views/platform/suites/SuiteRunDetailView.vue'),
      },
      {
        path: '/runs',
        name: 'platform.runs',
        meta: { title: 'Runs' },
        component: () => import('~/views/platform/runs/index.vue'),
      },
      {
        path: '/runs/new',
        name: 'platform.runs.new',
        meta: { title: 'Run a Test' },
        component: () => import('~/views/platform/runs/RunLaunchView.vue'),
      },
      {
        path: '/runs/:id',
        name: 'platform.runs.detail',
        meta: { title: 'Run' },
        component: () => import('~/views/platform/runs/RunConsoleView.vue'),
      },
      {
        path: '/references',
        name: 'platform.references',
        meta: { title: 'References' },
        component: () => import('~/views/platform/references/index.vue'),
      },
      {
        path: '/system/health',
        name: 'platform.health',
        meta: { title: 'API Status' },
        component: () => import('~/views/platform/health/index.vue'),
      },
      {
        path: '/:pathMatch(.*)*',
        name: 'not-found',
        meta: { title: 'Page not found' },
        component: () => import('~/views/NotFoundView.vue'),
      },
    ],
  },
]
