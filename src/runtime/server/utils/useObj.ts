import { Objm } from '@nats-io/obj'
import type { ObjectStore, ObjectStoreOptions } from '@nats-io/obj'
import { useNats } from './useNats'

const _objCache = new Map<string, ObjectStore>()

/** For integration tests only — clears the Object Store bucket cache. */
export function _clearObjCache() { _objCache.clear() }

/**
 * Get or open a NATS Object Store bucket.
 * Results are cached per bucket name within the process.
 *
 * @param bucket  Bucket name
 * @param opts    Object store options (only applied on first open)
 *
 * @example
 *   const obs = await useObj('avatars')
 *   await obs.put({ name: 'photo.png' }, fileBytes)
 *   const entry = await obs.get('photo.png')
 */
export async function useObj(bucket: string, opts?: Partial<ObjectStoreOptions>): Promise<ObjectStore> {
  if (_objCache.has(bucket)) {
    return _objCache.get(bucket)!
  }
  const nc = useNats()
  const objm = new Objm(nc)
  const obs = opts
    ? await objm.create(bucket, opts)
    : await objm.open(bucket)
  _objCache.set(bucket, obs)
  return obs
}
