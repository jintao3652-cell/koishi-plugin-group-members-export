import { Context, Logger } from 'koishi'
import { collectGroup, findBot } from './collect'
import { registerRoutes, ServerContext } from './server'
import { Config, defineModels } from './types'

export const name = 'group-members-export'
export const inject = ['database', 'server']

export { Config } from './types'
export type { GroupMember, GroupSnapshot } from './types'

const logger = new Logger('group-members-export')

export function apply(ctx: Context, config: Config) {
  defineModels(ctx)

  let disposed = false
  let inFlight: Promise<{ groups: number, members: number }> | null = null
  let lastCollectAt = 0

  const resolveGroups = async (): Promise<string[]> => {
    const configured = config.groups.map(id => String(id).trim()).filter(Boolean)
    if (configured.length) return [...new Set(configured)]
    const bot = findBot(ctx)
    if (!bot) return []
    try {
      const groups = await bot.internal!.getGroupList!()
      return (groups || []).map(group => String(group.group_id))
    } catch (error) {
      logger.warn(`failed to list groups: ${String(error)}`)
      return []
    }
  }

  const runCollect = async (): Promise<{ groups: number, members: number }> => {
    if (disposed) return { groups: 0, members: 0 }
    const bot = findBot(ctx)
    if (!bot) {
      logger.warn('no active onebot bot; collection skipped')
      return { groups: 0, members: 0 }
    }
    lastCollectAt = Date.now()
    let groups = 0
    let members = 0
    for (const groupId of await resolveGroups()) {
      if (disposed) break
      try {
        members += await collectGroup(ctx, bot, groupId)
        groups++
      } catch (error) {
        logger.warn(`group ${groupId} collection failed: ${String(error)}`)
      }
    }
    logger.info(`collected ${members} members from ${groups} groups`)
    return { groups, members }
  }

  // Concurrent triggers (scheduled tick + POST /api/collect) share one run so a
  // caller never receives a fake zero-count result while a collect is in flight.
  const collectAll = (): Promise<{ groups: number, members: number }> => {
    if (inFlight) return inFlight
    inFlight = runCollect().finally(() => { inFlight = null })
    return inFlight
  }

  const intervalMs = Math.max(1, config.intervalMinutes) * 60 * 1000
  let timer: (() => void) | undefined
  ctx.on('ready', () => {
    void collectAll()
    timer = ctx.setInterval(() => void collectAll(), intervalMs)
  })

  // OneBot bots are often still connecting when 'ready' fires; collect again as
  // soon as a usable bot shows up so the API has data right after startup.
  ctx.on('bot-status-updated', () => {
    if (disposed || !findBot(ctx)) return
    if (Date.now() - lastCollectAt < 60_000) return
    void collectAll()
  })

  registerRoutes(ctx as ServerContext, { config, collectNow: collectAll })

  ctx.on('dispose', () => {
    disposed = true
    timer?.()
    timer = undefined
  })
}
