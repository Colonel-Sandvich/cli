import { existsSync } from 'node:fs'
import { consola } from 'consola'
import { colors } from 'consola/utils'
import { resolve } from 'pathe'
import type { PackageJson } from 'pkg-types'
import { readPackageJSON } from 'pkg-types'
import { defineCommand } from 'citty'
import { addDependency, detectPackageManager } from 'nypm'
import { getPackageManagerVersion } from '../utils/packageManagers'
import { rmRecursive, touchFile } from '../utils/fs'
import { cleanupNuxtDirs, nuxtVersionToGitIdentifier } from '../utils/nuxt'

import { loadKit } from '../utils/kit'
import { cwdArgs, legacyRootDirArgs, logLevelArgs } from './_shared'

async function getNuxtVersion(path: string): Promise<string | null> {
  try {
    const pkg = await readPackageJSON('nuxt', { url: path })
    if (!pkg.version) {
      consola.warn('Cannot find any installed Nuxt versions in ', path)
    }
    return pkg.version || null
  }
  catch {
    return null
  }
}

function checkNuxtDependencyType(pkg: PackageJson): 'dependencies' | 'devDependencies' {
  if (pkg.dependencies?.['nuxt']) {
    return 'dependencies'
  }
  if (pkg.devDependencies?.['nuxt']) {
    return 'devDependencies'
  }
  return 'dependencies'
}

const nuxtVersionTags = {
  '3.x': '3x',
  '4.x': 'latest',
}

async function getNightlyVersion(packageNames: string[]): Promise<{ npmPackages: string[], nuxtVersion: string }> {
  const result = await consola.prompt(
    'Which nightly Nuxt release channel do you want to install? (3.x or 4.x)',
    {
      type: 'select',
      options: ['3.x', '4.x'],
      default: '3.x',
    },
  ) as '3.x' | '4.x'

  const nuxtVersion = typeof result === 'string' ? result : '3.x'

  const npmPackages = packageNames.map(p => `${p}@npm:${p}-nightly@${nuxtVersionTags[nuxtVersion]}`)

  return { npmPackages, nuxtVersion }
}

async function getRequiredNewVersion(packageNames: string[], channel: string): Promise<{ npmPackages: string[], nuxtVersion: string }> {
  if (channel === 'nightly') {
    return getNightlyVersion(packageNames)
  }

  return { npmPackages: packageNames.map(p => `${p}@latest`), nuxtVersion: '3' }
}

export default defineCommand({
  meta: {
    name: 'upgrade',
    description: 'Upgrade Nuxt',
  },
  args: {
    ...cwdArgs,
    ...logLevelArgs,
    ...legacyRootDirArgs,
    force: {
      type: 'boolean',
      alias: 'f',
      description: 'Force upgrade to recreate lockfile and node_modules',
    },
    channel: {
      type: 'string',
      alias: 'ch',
      default: 'stable',
      description: 'Specify a channel to install from (nightly or stable)',
    },
  },
  async run(ctx) {
    const cwd = resolve(ctx.args.cwd || ctx.args.rootDir)

    // Check package manager
    const packageManager = await detectPackageManager(cwd)
    if (!packageManager) {
      consola.error(
        `Unable to determine the package manager used by this project.\n\nNo lock files found in \`${cwd}\`, and no \`packageManager\` field specified in \`package.json\`.\n\nPlease either add the \`packageManager\` field to \`package.json\` or execute the installation command for your package manager. For example, you can use \`pnpm i\`, \`npm i\`, \`bun i\`, or \`yarn i\`, and then try again.`,
      )
      process.exit(1)
    }
    const { name: packageManagerName, lockFile: lockFileCandidates } = packageManager
    const packageManagerVersion = getPackageManagerVersion(packageManagerName)
    consola.info('Package manager:', packageManagerName, packageManagerVersion)

    // Check currently installed Nuxt version
    const currentVersion = (await getNuxtVersion(cwd)) || '[unknown]'
    consola.info('Current Nuxt version:', currentVersion)

    const pkg = await readPackageJSON(cwd).catch(() => null)

    // Check if Nuxt is a dependency or devDependency
    const nuxtDependencyType = pkg ? checkNuxtDependencyType(pkg) : 'dependencies'
    const corePackages = ['@nuxt/kit', '@nuxt/schema', '@nuxt/vite-builder', '@nuxt/webpack-builder', '@nuxt/rspack-builder']

    const packagesToUpdate = pkg ? corePackages.filter(p => pkg.dependencies?.[p] || pkg.devDependencies?.[p]) : []

    // Install latest version
    const { npmPackages, nuxtVersion } = await getRequiredNewVersion(['nuxt', ...packagesToUpdate], ctx.args.channel)

    // Force install
    const toRemove = ['node_modules']

    const lockFile = normaliseLockFile(cwd, lockFileCandidates)
    if (lockFile) {
      toRemove.push(lockFile)
    }

    const forceRemovals = toRemove
      .map(p => colors.cyan(p))
      .join(' and ')
    if (ctx.args.force === undefined) {
      ctx.args.force = await consola.prompt(
        `Would you like to recreate ${forceRemovals} to fix problems with hoisted dependency versions and ensure you have the most up-to-date dependencies?`,
        {
          type: 'confirm',
          default: true,
        },
      )
    }
    if (ctx.args.force) {
      consola.info(
        `Recreating ${forceRemovals}. If you encounter any issues, revert the changes and try with \`--no-force\``,
      )
      await rmRecursive(toRemove.map(file => resolve(cwd, file)))
      if (lockFile) {
        await touchFile(resolve(cwd, lockFile))
      }
    }

    const versionType = ctx.args.channel === 'nightly' ? 'nightly' : 'latest stable'
    consola.info(`Installing ${versionType} Nuxt ${nuxtVersion} release...`)

    await addDependency(npmPackages, {
      cwd,
      packageManager,
      dev: nuxtDependencyType === 'devDependencies' ? true : false,
    })

    // Clean up after upgrade
    let buildDir: string = '.nuxt'
    try {
      const { loadNuxtConfig } = await loadKit(cwd)
      const nuxtOptions = await loadNuxtConfig({ cwd })
      buildDir = nuxtOptions.buildDir
    }
    catch {
      // Use default buildDir (.nuxt)
    }
    await cleanupNuxtDirs(cwd, buildDir)

    // Check installed Nuxt version again
    const upgradedVersion = (await getNuxtVersion(cwd)) || '[unknown]'
    consola.info('Upgraded Nuxt version:', upgradedVersion)

    if (upgradedVersion === '[unknown]') {
      return
    }

    if (upgradedVersion === currentVersion) {
      consola.success('You\'re already using the latest version of Nuxt.')
    }
    else {
      consola.success(
        'Successfully upgraded Nuxt from',
        currentVersion,
        'to',
        upgradedVersion,
      )
      if (currentVersion === '[unknown]') {
        return
      }
      const commitA = nuxtVersionToGitIdentifier(currentVersion)
      const commitB = nuxtVersionToGitIdentifier(upgradedVersion)
      if (commitA && commitB) {
        consola.info(
          'Changelog:',
          `https://github.com/nuxt/nuxt/compare/${commitA}...${commitB}`,
        )
      }
    }
  },
})

// Find which lock file is in use since `nypm.detectPackageManager` doesn't return this
function normaliseLockFile(cwd: string, lockFiles: string | Array<string> | undefined) {
  if (typeof lockFiles === 'string') {
    lockFiles = [lockFiles]
  }

  const lockFile = lockFiles?.find(file => existsSync(resolve(cwd, file)))

  if (lockFile === undefined) {
    consola.error(`Unable to find any lock files in ${cwd}`)
    return undefined
  }

  return lockFile
}
