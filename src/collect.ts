import { Context, Logger } from 'koishi'
import { GroupMember, GroupRole } from './types'

const logger = new Logger('group-members-export')

interface RawGroupMember {
  group_id: number
  user_id: number
  nickname?: string
  card?: string
  role?: string
  title?: string
  join_time?: number
  last_sent_time?: number
  level?: string
}

interface RawGroupInfo {
  group_id: number
  group_name?: string
}

interface OneBotBot {
  platform?: string
  selfId?: string
  isActive?: boolean
  internal?: {
    _request?: unknown
    getGroupList?: () => Promise<RawGroupInfo[]>
    getGroupMemberList?: (groupId: number, noCache?: boolean) => Promise<RawGroupMember[]>
  }
}

export function normalizeRole(role?: string): GroupRole {
  return role === 'owner' || role === 'admin' || role === 'member' ? role : 'unknown'
}

function toDate(seconds?: number): Date | null {
  return seconds ? new Date(seconds * 1000) : null
}

/**
 * OneBot bots from the adapter expose the raw action set on `internal`.
 * `isActive` is already true while the socket is still connecting, so we also
 * require `_request`, which the adapter only installs once requests can be sent.
 */
export function findBot(ctx: Context): OneBotBot | undefined {
  return ctx.bots.find((bot: any) => bot.platform === 'onebot'
    && bot.isActive
    && typeof bot.internal?._request === 'function') as OneBotBot | undefined
}

export async function fetchGroupName(bot: OneBotBot, groupId: number): Promise<string> {
  try {
    const groups = (await bot.internal?.getGroupList?.()) || []
    return groups.find(group => group.group_id === groupId)?.group_name || ''
  } catch (error) {
    logger.warn(`get_group_list failed: ${String(error)}`)
    return ''
  }
}

export async function fetchMembers(bot: OneBotBot, groupId: number): Promise<RawGroupMember[]> {
  const members = await bot.internal?.getGroupMemberList?.(groupId, true)
  return Array.isArray(members) ? members : []
}

export function toMemberRow(
  groupId: string,
  groupName: string,
  raw: RawGroupMember,
  fetchedAt: Date,
): Omit<GroupMember, 'id'> {
  return {
    groupId,
    groupName,
    userId: String(raw.user_id),
    nickname: raw.nickname || '',
    card: raw.card || '',
    role: normalizeRole(raw.role),
    title: raw.title || '',
    joinTime: toDate(raw.join_time),
    lastSentTime: toDate(raw.last_sent_time),
    level: raw.level || '',
    fetchedAt,
  }
}

export async function saveMembers(ctx: Context, rows: Omit<GroupMember, 'id'>[]) {
  if (!rows.length) return
  await ctx.database.upsert('qq_group_member', rows, ['groupId', 'userId'])
  // Members who left the group would otherwise linger forever.
  const fetchedAt = rows[0].fetchedAt
  const stale = await ctx.database.get('qq_group_member', {
    groupId: rows[0].groupId,
    fetchedAt: { $lt: fetchedAt },
  }, ['userId'])
  const alive = new Set(rows.map(row => row.userId))
  const removed = stale.map(row => row.userId).filter(userId => !alive.has(userId))
  if (removed.length) {
    await ctx.database.remove('qq_group_member', { groupId: rows[0].groupId, userId: { $in: removed } })
  }
  return removed.length
}

export async function saveSnapshot(ctx: Context, groupId: string, groupName: string, memberCount: number, fetchedAt: Date) {
  await ctx.database.upsert('qq_group_snapshot', [{
    groupId, groupName, memberCount, fetchedAt,
  }], ['groupId'])
}

export async function collectGroup(ctx: Context, bot: OneBotBot, groupId: string): Promise<number> {
  const numericId = Number(groupId)
  const fetchedAt = new Date()
  const [groupName, members] = await Promise.all([
    fetchGroupName(bot, numericId),
    fetchMembers(bot, numericId),
  ])
  const rows = members.map(member => toMemberRow(groupId, groupName, member, fetchedAt))
  await saveMembers(ctx, rows)
  await saveSnapshot(ctx, groupId, groupName, rows.length, fetchedAt)
  return rows.length
}
