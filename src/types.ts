import { Context, Schema } from 'koishi'

export type GroupRole = 'owner' | 'admin' | 'member' | 'unknown'

export interface GroupMember {
  id: number
  groupId: string
  groupName: string
  userId: string
  nickname: string
  card: string
  role: GroupRole
  title: string
  joinTime: Date | null
  lastSentTime: Date | null
  level: string
  fetchedAt: Date
}

export interface GroupSnapshot {
  id: number
  groupId: string
  groupName: string
  memberCount: number
  fetchedAt: Date
}

declare module 'koishi' {
  interface Tables {
    qq_group_member: GroupMember
    qq_group_snapshot: GroupSnapshot
  }
}

export function defineModels(ctx: Context) {
  ctx.model.extend('qq_group_member', {
    id: 'unsigned',
    groupId: 'string(32)',
    groupName: 'string',
    userId: 'string(32)',
    nickname: 'string',
    card: 'string',
    role: 'string(16)',
    title: 'string',
    joinTime: 'timestamp',
    lastSentTime: 'timestamp',
    level: 'string(16)',
    fetchedAt: 'timestamp',
  }, {
    autoInc: true,
    unique: [['groupId', 'userId']],
  })

  ctx.model.extend('qq_group_snapshot', {
    id: 'unsigned',
    groupId: 'string(32)',
    groupName: 'string',
    memberCount: 'unsigned',
    fetchedAt: 'timestamp',
  }, {
    autoInc: true,
    unique: [['groupId']],
  })
}

export interface Config {
  groups: string[]
  intervalMinutes: number
  token: string
  allowOrigins: string[]
  pageSize: number
}

export const Config: Schema<Config> = Schema.object({
  groups: Schema.array(Schema.string()).role('table').default([]).description(
    '要采集的 QQ 群号。启动后每 `intervalMinutes` 分钟自动抓取这些群的全部成员；留空则采集机器人已加入的全部群。',
  ),
  intervalMinutes: Schema.number().min(1).max(1440).step(1).default(10).description('采集间隔（分钟）。'),
  token: Schema.string().role('secret').default('').description(
    'API 访问令牌。请求头需携带 `Authorization: Bearer <token>`，留空则不注册 HTTP API 路由。',
  ),
  allowOrigins: Schema.array(Schema.string()).role('table').default(['*']).description(
    '允许跨域访问的来源。默认 `*`；带 `Authorization` 头的跨域请求需要浏览器先发 OPTIONS 预检。',
  ),
  pageSize: Schema.number().min(1).max(1000).step(1).default(200).description('列表接口默认每页条数。'),
})
