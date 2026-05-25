import { readFile } from 'node:fs/promises'
import {
  isNativeAudioAvailable,
  isNativeRecordingActive,
} from '../packages/audio-capture-napi/src/index.js'
import { renderUnifiedDiff } from '../packages/color-diff-napi/src/index.js'
import { createChromeMcpServer, decodeChromeMcpSocketMessages, encodeChromeMcpSocketMessage, handleChromeToolCall } from '../packages/@ant/claude-for-chrome-mcp/src/index.js'
import { createInputBackend } from '../packages/@ant/computer-use-input/src/index.js'
import { createComputerUseRuntime } from '../packages/@ant/computer-use-swift/src/index.js'
import {
  buildComputerUseTools,
  comparePixelAtLocation,
  handleToolCall,
  targetImageSize,
} from '../packages/@ant/computer-use-mcp/src/index.js'
import { readPngDimensions } from '../packages/image-processor-napi/src/index.js'
import { isModifierPressed } from '../packages/modifiers-napi/src/index.js'
import { enqueueUrlEvent, pollUrlEvent, waitForUrlEvent } from '../packages/url-handler-napi/src/index.js'

type NativeGolden = {
  version: string
  cases: Array<{
    name: string
    expect: Record<string, unknown>
  }>
}

type GoldenFailure = {
  caseName: string
  reason: string
}

const fixturePath = 'docs/refactor/golden/native/r2.0-native-platform-golden.json'
const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as NativeGolden
const failures: GoldenFailure[] = []

for (const testCase of fixture.cases) {
  try {
    switch (testCase.name) {
      case 'native-package-load':
        verifyNativePackageLoad(testCase.expect)
        break
      case 'url-handler-protocol':
        await verifyUrlHandlerProtocol(testCase.expect)
        break
      case 'computer-use-platform':
        await verifyComputerUsePlatform(testCase.expect)
        break
      case 'chrome-mcp-platform':
        await verifyChromeMcpPlatform(testCase.expect)
        break
      default:
        failures.push({ caseName: testCase.name, reason: 'unknown R2.0 golden case' })
    }
  } catch (error) {
    failures.push({
      caseName: testCase.name,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
}

console.log(JSON.stringify({
  fixture: fixturePath,
  status: failures.length === 0 ? 'pass' : 'fail',
  cases: fixture.cases.length,
  failures,
}, null, 2))

if (failures.length > 0) {
  process.exit(1)
}
process.exit(0)

function verifyNativePackageLoad(expect: Record<string, unknown>): void {
  assertEqual(typeof isNativeAudioAvailable(), expect.audioAvailableType, 'audioAvailableType')
  assertEqual(isNativeRecordingActive(), false, 'audioRecordingInactive')
  assertEqual(isModifierPressed('shift'), expect.modifierShift, 'modifierShift')
  assertEqual(renderUnifiedDiff('a\nb', 'a\nc').includes('+c'), expect.diffIncludesInsert, 'diffIncludesInsert')
  const size = readPngDimensions(makePngHeader(2, 3))
  assertEqual(size?.width, expect.pngWidth, 'pngWidth')
  assertEqual(size?.height, expect.pngHeight, 'pngHeight')
}

async function verifyUrlHandlerProtocol(expect: Record<string, unknown>): Promise<void> {
  assertEqual(enqueueUrlEvent(String(expect.url)), expect.accepted, 'accepted')
  assertEqual(pollUrlEvent()?.url, expect.url, 'pollUrl')
  assertEqual(enqueueUrlEvent('https://example.com'), expect.rejected, 'rejected')

  const previous = process.env.CLAUDE_CODE_URL_EVENT
  process.env.CLAUDE_CODE_URL_EVENT = String(expect.url)
  try {
    const event = await waitForUrlEvent()
    assertEqual(event?.source, expect.source, 'source')
    assertEqual(event?.url, expect.url, 'envUrl')
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_CODE_URL_EVENT
    } else {
      process.env.CLAUDE_CODE_URL_EVENT = previous
    }
  }
}

async function verifyComputerUsePlatform(expect: Record<string, unknown>): Promise<void> {
  const input = createInputBackend('linux')
  assertEqual(input.supported, expect.inputSupported, 'inputSupported')
  assertEqual((await input.preflight()).supported, expect.inputSupported, 'preflightSupported')

  const runtime = createComputerUseRuntime('linux')
  assertEqual(runtime.supported, false, 'swiftUnsupported')
  assertEqual((await runtime.getRunningApplications()).length, 0, 'runningApplications')

  const tools = buildComputerUseTools()
  assertEqual(tools.length, expect.toolCount, 'toolCount')
  const blocked = await handleToolCall({
    name: 'computer.key',
    input: { key: 'cmd+q' },
  }, { sessionId: 'r2' })
  assertEqual(blocked.status, expect.blockedStatus, 'blockedStatus')

  const target = targetImageSize({ width: 200, height: 100 }, { width: 100, height: 100 })
  assertEqual(target.width, expect.targetWidth, 'targetWidth')
  assertEqual(target.height, expect.targetHeight, 'targetHeight')
  assertEqual(comparePixelAtLocation([1, 2, 3, 255], [1, 2, 4, 255], 1), expect.pixelEqual, 'pixelEqual')
}

async function verifyChromeMcpPlatform(expect: Record<string, unknown>): Promise<void> {
  const server = createChromeMcpServer()
  assertEqual(server.name, expect.serverName, 'serverName')
  assertEqual(server.tools.length, expect.toolCount, 'toolCount')
  const result = await handleChromeToolCall({
    name: 'chrome.inspect',
    input: {},
  })
  assertEqual(result.status, expect.unsupportedStatus, 'unsupportedStatus')

  const encoded = encodeChromeMcpSocketMessage({ id: '1', method: 'tools/list' })
  assertEqual(decodeChromeMcpSocketMessages(encoded)[0]?.method, expect.decodedMethod, 'decodedMethod')
}

function makePngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
