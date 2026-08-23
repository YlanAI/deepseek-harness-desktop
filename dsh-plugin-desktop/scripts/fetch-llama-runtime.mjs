/** Fetch and verify the pinned Windows llama.cpp CUDA runtime. */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspaceRoot = resolve(desktopRoot, '..')
const downloadRoot = join(workspaceRoot, '.build', 'downloads')
const runtimeRoot = join(workspaceRoot, '.build', 'llama', 'windows-x64')
const markerPath = join(runtimeRoot, '.runtime.json')

export const LLAMA_RUNTIME = Object.freeze({
  tag: 'b10566',
  build: 10566,
  commit: 'bb4caa754',
  cuda: '13.3',
  platform: 'win32',
  arch: 'x64',
  archives: Object.freeze([
    Object.freeze({
      filename: 'llama-b10566-bin-win-cuda-13.3-x64.zip',
      sha256: 'c3e2336c1427e8bd7b5beb3c8618d2f7a268bc5fb6ec3f28c1e06cdb78d2e80a',
    }),
    Object.freeze({
      filename: 'cudart-llama-bin-win-cuda-13.3-x64.zip',
      sha256: '1462a050eb4c684921ba51dcc4cc488a036674c3e73e9945ee705b854808d03e',
    }),
  ]),
})

const required = Object.freeze([
  'llama-server.exe',
  'llama-server-impl.dll',
  'llama-common.dll',
  'llama.dll',
  'ggml.dll',
  'ggml-base.dll',
  'ggml-cuda.dll',
  'cudart64_13.dll',
  'cublas64_13.dll',
  'cublasLt64_13.dll',
  'libomp.dll',
  'mtmd.dll',
])

function runtimeReady() {
  if (!existsSync(markerPath)) return false
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
    return marker.tag === LLAMA_RUNTIME.tag
      && marker.cuda === LLAMA_RUNTIME.cuda
      && required.every(filename => existsSync(join(runtimeRoot, filename)))
      && existsSync(join(runtimeRoot, 'ggml-cpu-x64.dll'))
  } catch {
    return false
  }
}

async function sha256(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

async function download(archive) {
  mkdirSync(downloadRoot, { recursive: true })
  const target = join(downloadRoot, archive.filename)
  if (existsSync(target) && await sha256(target) === archive.sha256) return target
  const temporary = `${target}.part-${String(process.pid)}`
  rmSync(temporary, { force: true })
  const url = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RUNTIME.tag}/${archive.filename}`
  process.stdout.write(`Downloading ${archive.filename}\n`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || response.body === null) {
    throw new Error(`llama.cpp runtime download failed (${String(response.status)} ${response.statusText})`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }))
  const actual = await sha256(temporary)
  if (actual !== archive.sha256) {
    rmSync(temporary, { force: true })
    throw new Error(`llama.cpp runtime checksum mismatch for ${archive.filename}`)
  }
  rmSync(target, { force: true })
  renameSync(temporary, target)
  return target
}

function shouldExtract(name) {
  const filename = name.replaceAll('\\', '/').split('/').at(-1) ?? ''
  return filename === 'llama-server.exe'
    || filename.toLowerCase().endsWith('.dll')
    || filename.startsWith('LICENSE')
}

function extract(archives) {
  rmSync(runtimeRoot, { recursive: true, force: true })
  mkdirSync(runtimeRoot, { recursive: true })
  for (const archivePath of archives) {
    const zip = new AdmZip(archivePath)
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory || !shouldExtract(entry.entryName)) continue
      const filename = entry.entryName.replaceAll('\\', '/').split('/').at(-1)
      if (filename === undefined || filename.length === 0) continue
      writeFileSync(join(runtimeRoot, filename), entry.getData())
    }
  }
  for (const filename of required) {
    if (!existsSync(join(runtimeRoot, filename))) {
      throw new Error(`llama.cpp runtime archive is missing ${filename}`)
    }
  }
  if (!existsSync(join(runtimeRoot, 'ggml-cpu-x64.dll'))) {
    throw new Error('llama.cpp runtime archive is missing the x64 CPU fallback library')
  }
  writeFileSync(markerPath, `${JSON.stringify(LLAMA_RUNTIME, undefined, 2)}\n`)
}

if (!runtimeReady()) extract(await Promise.all(LLAMA_RUNTIME.archives.map(download)))
process.stdout.write(`llama.cpp ${LLAMA_RUNTIME.tag} CUDA ${LLAMA_RUNTIME.cuda} runtime ready at ${runtimeRoot}\n`)
