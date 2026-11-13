import { jest } from '@jest/globals'
import type { PathLike } from 'fs'
import * as realFs from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// Simulates a write that dies half-way (ENOSPC, EIO, process killed between syscalls):
// whatever was written so far stays on disk and the call rejects.
let failNextWrite = false
const writeFile = jest.fn(async (path: PathLike, data: string, options?: object) => {
	if (!failNextWrite) {
		return realFs.writeFile(path, data, options)
	}

	failNextWrite = false
	await realFs.writeFile(path, data.slice(0, Math.floor(data.length / 2)), options)
	throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
})

jest.unstable_mockModule('fs/promises', () => ({ ...realFs, writeFile }))

const { useMultiFileAuthState } = await import('../../Utils/use-multi-file-auth-state')

describe('useMultiFileAuthState interrupted writes', () => {
	let folder: string

	beforeEach(async () => {
		folder = await realFs.mkdtemp(join(tmpdir(), 'baileys-auth-interrupted-'))
	})

	afterEach(async () => {
		await realFs.rm(folder, { recursive: true, force: true })
	})

	it('keeps the previous creds.json when a save fails mid-write', async () => {
		const first = await useMultiFileAuthState(folder)
		await first.saveCreds()
		const before = await realFs.readFile(join(folder, 'creds.json'), 'utf-8')

		first.state.creds.registered = true
		failNextWrite = true
		await expect(first.saveCreds()).rejects.toMatchObject({ code: 'ENOSPC' })

		expect(await realFs.readFile(join(folder, 'creds.json'), 'utf-8')).toBe(before)
		expect(await realFs.readdir(folder)).toEqual(['creds.json'])

		// a restart must load the same identity, not silently fall back to fresh creds
		const reloaded = await useMultiFileAuthState(folder)
		expect(reloaded.state.creds.registrationId).toBe(first.state.creds.registrationId)
		expect(reloaded.state.creds.signedIdentityKey.public).toEqual(first.state.creds.signedIdentityKey.public)
		expect(reloaded.state.creds.registered).toBe(false)
	})

	it('keeps the previous signal key file when a key write fails mid-write', async () => {
		const { state } = await useMultiFileAuthState(folder)
		const session = { a: 'x'.repeat(1024) } as never
		await state.keys.set({ session: { 'jid.0': session } })

		failNextWrite = true
		await expect(state.keys.set({ session: { 'jid.0': { a: 'y'.repeat(1024) } as never } })).rejects.toMatchObject({
			code: 'ENOSPC'
		})

		const stored = await state.keys.get('session', ['jid.0'])
		expect(stored['jid.0']).toEqual(session)
		expect((await realFs.readdir(folder)).filter(f => f.endsWith('.tmp'))).toEqual([])
	})
})
