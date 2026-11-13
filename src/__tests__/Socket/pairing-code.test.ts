import { jest } from '@jest/globals'
import { EventEmitter } from 'events'
import P from 'pino'
import type { BinaryNode } from '../../WABinary'

const send = jest.fn((_data: unknown, cb?: (err?: Error) => void) => {
	cb?.()
	return true
})

class MockWebSocketClient extends EventEmitter {
	isOpen = true
	isClosed = false
	isClosing = false
	isConnecting = false
	connect() {}
	async close() {}
	send = send
}

jest.unstable_mockModule('../../Socket/Client/websocket', () => ({ WebSocketClient: MockWebSocketClient }))

const { DEFAULT_CONNECTION_CONFIG } = await import('../../Defaults')
const { default: makeWASocket } = await import('../../Socket')
const { Browsers } = await import('../../Utils/browser-utils')
const { getPairingCodePlatformDisplay } = await import('../../Utils/companion-reg-client-utils')
const { makeSession } = await import('../TestUtils/session')

const PHONE = '5511999999999'

const setup = async () => {
	const { state, clear } = await makeSession()
	const lines: string[] = []
	const logger = P({ level: 'trace' }, { write: (line: string) => lines.push(line) })
	const sock = makeWASocket({
		...DEFAULT_CONNECTION_CONFIG,
		auth: state,
		logger,
		browser: ['My App', 'Chrome', '1.0.0']
	})
	const credsUpdates = jest.fn()
	sock.ev.on('creds.update', credsUpdates)

	// resolves with the companion_hello IQ once it has been written to the socket
	const sentCompanionHello = async () => {
		for (let i = 0; i < 100; i++) {
			const xml = lines
				.map(line => JSON.parse(line) as { xml?: string })
				.map(entry => entry.xml)
				.find(xml => xml?.includes('companion_hello'))
			if (xml) {
				return { xml, id: /<iq[^>]* id='([^']+)'/.exec(xml)![1]! }
			}

			await new Promise(resolve => setTimeout(resolve, 10))
		}

		throw new Error('companion_hello was not sent')
	}

	const finish = async () => {
		await sock.end(new Error('Test completed'))
		await clear()
	}

	return { sock, state, credsUpdates, sentCompanionHello, finish }
}

describe('requestPairingCode', () => {
	jest.setTimeout(30_000)

	it('returns the code and persists creds.me once the server accepts companion_hello', async () => {
		const { sock, state, credsUpdates, sentCompanionHello, finish } = await setup()
		try {
			const code = sock.requestPairingCode(PHONE)
			const { xml, id } = await sentCompanionHello()

			expect(xml).toContain('Chrome (Mac OS)')
			expect(state.creds.me).toBeUndefined()

			sock.ws.emit(`TAG:${id}`, { tag: 'iq', attrs: { id, type: 'result', from: '@s.whatsapp.net' } } as BinaryNode)

			await expect(code).resolves.toHaveLength(8)
			expect(state.creds.me?.id).toBe(`${PHONE}@s.whatsapp.net`)
			expect(state.creds.pairingCode).toBe(await code)
			expect(credsUpdates).toHaveBeenCalled()
		} finally {
			await finish()
		}
	})

	it('rejects and leaves no pairing state when the server rejects companion_hello', async () => {
		const { sock, state, credsUpdates, sentCompanionHello, finish } = await setup()
		try {
			const code = sock.requestPairingCode(PHONE)
			const { id } = await sentCompanionHello()

			sock.ws.emit(`TAG:${id}`, {
				tag: 'iq',
				attrs: { id, type: 'error', from: '@s.whatsapp.net' },
				content: [{ tag: 'error', attrs: { code: '400', text: 'bad-request' } }]
			} as BinaryNode)

			await expect(code).rejects.toMatchObject({ message: 'bad-request', data: 400 })
			expect(state.creds.me).toBeUndefined()
			expect(state.creds.pairingCode).toBeUndefined()
			expect(credsUpdates).not.toHaveBeenCalled()
		} finally {
			await finish()
		}
	})
})

describe('getPairingCodePlatformDisplay', () => {
	it('keeps known OS labels', () => {
		expect(getPairingCodePlatformDisplay(Browsers.macOS('Chrome'))).toBe('Chrome (Mac OS)')
		expect(getPairingCodePlatformDisplay(Browsers.ubuntu('Firefox'))).toBe('Firefox (Ubuntu)')
		expect(getPairingCodePlatformDisplay(Browsers.windows('Edge'))).toBe('Edge (Windows)')
	})

	it('replaces a custom OS label that the server would reject', () => {
		expect(getPairingCodePlatformDisplay(['My App', 'Chrome', '1.0.0'])).toBe('Chrome (Mac OS)')
		expect(getPairingCodePlatformDisplay(Browsers.baileys('Safari'))).toBe('Safari (Mac OS)')
	})
})
