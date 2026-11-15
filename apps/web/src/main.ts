import { createApp } from 'vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'

import '~/styles/index.css'

import App from './app.vue'
import router from './router'

const app = createApp(App)

app.use(createPinia().use(piniaPluginPersistedstate))
app.use(VueQueryPlugin, {
  queryClient: new QueryClient({
    defaultOptions: { queries: { retry: 1, staleTime: 5_000, refetchOnWindowFocus: false } },
  }),
})
app.use(router)

app.mount('#app')
