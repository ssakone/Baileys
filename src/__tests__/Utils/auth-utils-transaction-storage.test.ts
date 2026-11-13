import { jest } from '@jest/globals'
import { AsyncLocalStorage } from 'async_hooks'
import type { SignalDataSet, SignalKeyStore } from '../../Types'
import { addTransactionCapability } from '../../Utils/auth-utils'
import type { ILogger } from '../../Utils/logger'

const logger = {
	level: 'silent',
	child: () => logger,
	trace: () => {},
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {}
} as unknown as ILogger

const opts = { maxCommitRetries: 1, delayBetweenTriesMs: 1 }

// in-memory backing store for 'lid-mapping' only, enough to observe where writes land
const makeBackingStore = () => {
	const data = new Map<string, string>()
	const store: SignalKeyStore = {
		get: async (_type, ids) => {
			const out: { [id: string]: string } = {}
			for (const id of ids) {
				const value = data.get(id)
				if (value !== undefined) out[id] = value
			}

			return out as never
		},
		set: async (set: SignalDataSet) => {
			for (const [id, value] of Object.entries(set['lid-mapping'] ?? {})) {
				if (value === null) data.delete(id)
				else data.set(id, value)
			}
		}
	}
	return { store, data }
}

const write = (value: string): SignalDataSet => ({ 'lid-mapping': { id: value } })

describe('addTransactionCapability transaction storage', () => {
	afterEach(() => {
		jest.restoreAllMocks()
	})

	it('uses one AsyncLocalStorage for every wrapped store', async () => {
		const instances = new Set<AsyncLocalStorage<unknown>>()
		const originalRun = AsyncLocalStorage.prototype.run
		jest.spyOn(AsyncLocalStorage.prototype, 'run').mockImplementation(function (
			this: AsyncLocalStorage<unknown>,
			...args: Parameters<typeof originalRun>
		) {
			instances.add(this)
			return originalRun.apply(this, args)
		})

		for (let i = 0; i < 50; i++) {
			const keys = addTransactionCapability(makeBackingStore().store, logger, opts)
			await keys.transaction(async () => {}, 'key')
		}

		expect(instances.size).toBe(1)
	})

	it('does not leak a transaction context into another store', async () => {
		const a = makeBackingStore()
		const b = makeBackingStore()
		const keysA = addTransactionCapability(a.store, logger, opts)
		const keysB = addTransactionCapability(b.store, logger, opts)

		await keysA.transaction(async () => {
			expect(keysA.isInTransaction()).toBe(true)
			expect(keysB.isInTransaction()).toBe(false)

			await keysA.set(write('a'))
			await keysB.set(write('b'))

			// b is not in a transaction, so its write is immediate; a's is buffered until commit
			expect(b.data.get('id')).toBe('b')
			expect(a.data.has('id')).toBe(false)
		}, 'tx')

		expect(a.data.get('id')).toBe('a')
		expect(b.data.get('id')).toBe('b')
	})

	it('keeps nested transactions on different stores isolated', async () => {
		const a = makeBackingStore()
		const b = makeBackingStore()
		const keysA = addTransactionCapability(a.store, logger, opts)
		const keysB = addTransactionCapability(b.store, logger, opts)

		await keysA.transaction(async () => {
			await keysA.set(write('a'))

			await keysB.transaction(async () => {
				expect(keysA.isInTransaction()).toBe(true)
				expect(keysB.isInTransaction()).toBe(true)
				await keysB.set(write('b'))
				expect((await keysA.get('lid-mapping', ['id'])).id).toBe('a')
				expect((await keysB.get('lid-mapping', ['id'])).id).toBe('b')
			}, 'tx')

			// b committed when its own transaction ended; a is still open
			expect(keysB.isInTransaction()).toBe(false)
			expect(keysA.isInTransaction()).toBe(true)
			expect(b.data.get('id')).toBe('b')
			expect(a.data.has('id')).toBe(false)
		}, 'tx')

		expect(a.data.get('id')).toBe('a')
	})

	it('still reuses the context for a nested transaction on the same store', async () => {
		const a = makeBackingStore()
		const keysA = addTransactionCapability(a.store, logger, opts)

		await keysA.transaction(async () => {
			await keysA.set(write('outer'))
			await keysA.transaction(async () => {
				expect((await keysA.get('lid-mapping', ['id'])).id).toBe('outer')
				await keysA.set(write('inner'))
			}, 'tx')

			// the nested call shares the outer context, so nothing is committed yet
			expect(a.data.has('id')).toBe(false)
		}, 'tx')

		expect(a.data.get('id')).toBe('inner')
	})
})
