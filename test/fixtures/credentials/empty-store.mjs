// A SecretStore that is always empty and never written (live rotator dry runs).
export default {
  name: 'empty',
  async read() {
    return undefined
  },
  async write() {
    throw new Error('dry run must not write')
  },
}
