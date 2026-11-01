import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const packageJson = readJson(join(root, 'package.json'))
const tauriConfig = readJson(join(root, 'src-tauri', 'tauri.conf.json'))
const windowsConfig = readJson(join(root, 'src-tauri', 'tauri.windows.conf.json'))
const cargoToml = readFileSync(join(root, 'src-tauri', 'Cargo.toml'), 'utf8')
const cargoLock = readFileSync(join(root, 'src-tauri', 'Cargo.lock'), 'utf8')

const effectiveWindowsConfig = mergeConfig(tauriConfig, windowsConfig)
const expectedVersion = packageJson.version
const expectedIdentifier = 'com.local.flick'
const expectedTarget = 'x86_64-pc-windows-msvc'
const expectedMachine = 0x8664
const productName = effectiveWindowsConfig.productName ?? packageJson.productName ?? 'Flick'
const cargoPackageName = cargoPackageField(cargoToml, 'name') ?? 'flick'
const configuredTargetRoot = process.env.CARGO_TARGET_DIR
const targetRoot = configuredTargetRoot
  ? isAbsolute(configuredTargetRoot)
    ? configuredTargetRoot
    : resolve(root, configuredTargetRoot)
  : join(root, 'src-tauri', 'target')
const releaseRoot = join(targetRoot, expectedTarget, 'release')
const appExecutable = join(releaseRoot, `${cargoPackageName}.exe`)
const nsisDirectory = join(releaseRoot, 'bundle', 'nsis')
const expectedInstaller = join(
  nsisDirectory,
  `${productName}_${expectedVersion}_x64-setup.exe`
)
const checksumFile = join(nsisDirectory, 'SHA256SUMS.txt')
const errors = []

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function mergeConfig(base, override) {
  if (Array.isArray(override) || !override || typeof override !== 'object') return override
  const result = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(override)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeConfig(result[key], value)
      : value
  }
  return result
}

function cargoPackageField(contents, field) {
  const packageStart = contents.search(/^\[package\]\s*$/mu)
  if (packageStart < 0) return undefined
  const afterHeader = contents.indexOf('\n', packageStart)
  if (afterHeader < 0) return undefined
  const remainder = contents.slice(afterHeader + 1)
  const nextSection = remainder.search(/^\[/mu)
  const packageSection = nextSection < 0 ? remainder : remainder.slice(0, nextSection)
  return packageSection.match(new RegExp(`^${field}\\s*=\\s*"([^"]+)"`, 'mu'))?.[1]
}

function packageLockVersion(contents) {
  const packageBlocks = contents.split(/\n(?=\[\[package\]\])/u)
  for (const block of packageBlocks) {
    if (/^name\s*=\s*"flick"$/mu.test(block)) {
      return block.match(/^version\s*=\s*"([^"]+)"$/mu)?.[1]
    }
  }
  return undefined
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    errors.push(`${label} 不存在：${relative(root, path)}`)
    return false
  }
  if (statSync(path).size === 0) {
    errors.push(`${label} 是空文件：${relative(root, path)}`)
    return false
  }
  return true
}

function peMachine(path) {
  const executable = readFileSync(path)
  if (executable.length < 64 || executable[0] !== 0x4d || executable[1] !== 0x5a) {
    throw new Error('缺少 MZ 文件头')
  }
  const peOffset = executable.readUInt32LE(0x3c)
  if (peOffset + 6 > executable.length) throw new Error('PE 文件头超出文件范围')
  if (executable.toString('ascii', peOffset, peOffset + 4) !== 'PE\u0000\u0000') {
    throw new Error('缺少 PE 文件头')
  }
  return executable.readUInt16LE(peOffset + 4)
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function sameMembers(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && expected.every((entry) => actual.includes(entry))
}

const cargoVersion = cargoPackageField(cargoToml, 'version')
const lockVersion = packageLockVersion(cargoLock)
if (typeof expectedVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(expectedVersion)) {
  errors.push(`package.json 版本不是有效的三段式版本号：${expectedVersion ?? '未找到'}`)
}
for (const [label, actual] of [
  ['package.json', packageJson.version],
  ['Tauri base config', tauriConfig.version],
  ['Tauri Windows override', windowsConfig.version],
  ['Windows 有效 Tauri 配置', effectiveWindowsConfig.version],
  ['Cargo.toml', cargoVersion],
  ['Cargo.lock', lockVersion]
]) {
  if (actual !== expectedVersion) {
    errors.push(`${label} 版本必须为 ${expectedVersion}，实际为 ${actual ?? '未找到'}`)
  }
}

if (effectiveWindowsConfig.identifier !== expectedIdentifier) {
  errors.push(
    `Windows 有效 Bundle ID 必须为 ${expectedIdentifier}，实际为 ${effectiveWindowsConfig.identifier}`
  )
}
if (packageJson.productName !== productName) {
  errors.push(`package.json 与 Tauri 产品名不一致：${packageJson.productName} / ${productName}`)
}

const settingsWindows = Array.isArray(effectiveWindowsConfig.app?.windows)
  ? effectiveWindowsConfig.app.windows.filter((window) => window?.label === 'settings')
  : []
if (settingsWindows.length !== 1) {
  errors.push(`Windows 有效 Tauri 配置必须恰好包含一个 settings 主窗口，实际为 ${settingsWindows.length} 个`)
} else {
  const settingsWindow = settingsWindows[0]
  if (settingsWindow.visible !== false) {
    errors.push('Windows settings 窗口必须配置 visible=false，确保普通启动不弹出设置页')
  }
  if (settingsWindow.skipTaskbar !== false) {
    errors.push('Windows settings 主窗口必须配置 skipTaskbar=false，确保显示在任务栏')
  }
}

const windowsBundle = effectiveWindowsConfig.bundle ?? {}
const windowsInstaller = windowsBundle.windows ?? {}
const nsis = windowsInstaller.nsis ?? {}
if (!sameMembers(windowsBundle.targets, ['nsis'])) {
  errors.push('Windows bundle targets 必须仅包含 nsis')
}
if (!sameMembers(windowsBundle.icon, ['../apps/windows/icons/icon.ico'])) {
  errors.push('Windows bundle 必须使用 ../apps/windows/icons/icon.ico')
}
if (nsis.installMode !== 'currentUser') {
  errors.push('NSIS installMode 必须为 currentUser')
}
if (windowsInstaller.allowDowngrades !== false) {
  errors.push('Windows 安装包必须禁止降级安装')
}
if (
  windowsInstaller.webviewInstallMode?.type !== 'downloadBootstrapper'
  || windowsInstaller.webviewInstallMode?.silent !== true
) {
  errors.push('Windows 安装包必须静默使用 WebView2 downloadBootstrapper')
}
if (!sameMembers(nsis.languages, ['SimpChinese', 'English'])) {
  errors.push('NSIS languages 必须包含 SimpChinese 和 English')
}
if (
  nsis.installerIcon !== '../apps/windows/icons/icon.ico'
  || nsis.uninstallerIcon !== '../apps/windows/icons/icon.ico'
) {
  errors.push('NSIS 安装与卸载图标必须使用 ../apps/windows/icons/icon.ico')
}
if (nsis.displayLanguageSelector !== false || nsis.compression !== 'lzma') {
  errors.push('NSIS 必须关闭语言选择器并使用 lzma 压缩')
}
if (nsis.startMenuFolder !== 'Flick') {
  errors.push('NSIS 开始菜单目录必须为 Flick')
}
const windowsBuildCommand = packageJson.scripts?.['build:windows'] ?? ''
for (const requiredArgument of [
  '--target x86_64-pc-windows-msvc',
  '--bundles nsis',
  '--ci',
  '--no-sign'
]) {
  if (!windowsBuildCommand.includes(requiredArgument)) {
    errors.push(`build:windows 缺少参数：${requiredArgument}`)
  }
}

const resources = windowsBundle.resources ?? {}
for (const [source, destination] of [
  ['../THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
  ['../LICENSE.selection-hook', 'LICENSE.selection-hook']
]) {
  if (resources[source] !== destination) {
    errors.push(`Windows bundle 必须包含资源 ${source} -> ${destination}`)
  }
  requireFile(resolve(root, 'src-tauri', source), `发布声明 ${source}`)
}

if (requireFile(appExecutable, 'Windows 主程序')) {
  try {
    const machine = peMachine(appExecutable)
    if (machine !== expectedMachine) {
      errors.push(
        `Windows 主程序必须为 x64 PE（0x8664），实际为 0x${machine.toString(16)}`
      )
    }
  } catch (error) {
    errors.push(`无法校验 Windows 主程序架构：${error.message}`)
  }
}

if (existsSync(nsisDirectory)) {
  const installers = readdirSync(nsisDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('-setup.exe'))
    .map((entry) => entry.name)
  if (installers.length !== 1 || installers[0] !== basename(expectedInstaller)) {
    errors.push(
      `NSIS 输出目录必须只包含当前版本安装包 ${basename(expectedInstaller)}，实际找到：${installers.length > 0 ? installers.join(', ') : '无'}`
    )
  }
}

let installerDigest
if (requireFile(expectedInstaller, '当前版本 x64 NSIS 安装包')) {
  const installer = readFileSync(expectedInstaller)
  if (installer.length < 2 || installer[0] !== 0x4d || installer[1] !== 0x5a) {
    errors.push('NSIS 安装包不是有效的 Windows 可执行文件')
  } else {
    installerDigest = sha256(expectedInstaller)
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  const checksum = `${installerDigest}  ${basename(expectedInstaller)}\n`
  writeFileSync(checksumFile, checksum, 'utf8')
  console.log(`Windows 产物检查通过：${basename(appExecutable)} 为纯 x64 PE。`)
  console.log(`NSIS 安装包：${relative(root, expectedInstaller)}`)
  console.log(`SHA-256：${installerDigest}`)
  console.log(`校验文件：${relative(root, checksumFile)}`)
  console.log('说明：该安装包使用 --no-sign 构建，是未签名测试版。')
}
