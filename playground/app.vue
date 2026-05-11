<template>
  <div style="font-family: monospace; padding: 2rem; max-width: 600px">
    <h1>nuxt-nats playground</h1>

    <section>
      <h2>Health</h2>
      <pre>{{ health ?? 'loading...' }}</pre>
      <button @click="refreshHealth">Refresh</button>
    </section>

    <section style="margin-top: 2rem">
      <h2>Publish to events.demo</h2>
      <input v-model="message" placeholder="message" style="width: 300px" />
      <button @click="emit" :disabled="publishing">{{ publishing ? 'Publishing…' : 'Publish' }}</button>
      <p v-if="result">{{ result }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
const message = ref('hello world')
const publishing = ref(false)
const result = ref('')

const { data: health, refresh: refreshHealth } = await useFetch('/api/_nats/health')

async function emit() {
  publishing.value = true
  result.value = ''
  try {
    await $fetch('/api/emit', { method: 'POST', body: { message: message.value } })
    result.value = 'Published!'
  }
  catch (e: unknown) {
    result.value = `Error: ${e instanceof Error ? e.message : String(e)}`
  }
  finally {
    publishing.value = false
  }
}
</script>
