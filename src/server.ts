import { Context, Logger } from 'koishi'
import { IncomingMessage } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { Config } from './types'

const logger = new Logger('group-members-export')

export interface ApiContext {
  config: Config
  collectNow(): Promise<{ groups: number, members: number }>
}

/** Minimal Koa router/context shapes so the plugin works without extra type deps. */
export interface RouteContext {
  req: IncomingMessage
  method: string
  path: string
  origin: string
  status: number
  body: unknown
  set(name: string, value: string): void
}

export interface RouterLike {
  selfUrl?: string
  get(path: string | RegExp, ...handlers: any[]): unknown
  post(path: string | RegExp, ...handlers: any[]): unknown
  options(path: string | RegExp, ...handlers: any[]): unknown
}

export type ServerContext = Context & { server: RouterLike }

/** Constant-time compare that also hides the token length. */
export function tokenMatches(expected: string, provided: string): boolean {
  if (!expected || !provided) return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  const length = Math.max(a.length, b.length, 1)
  const paddedA = Buffer.alloc(length)
  const paddedB = Buffer.alloc(length)
  a.copy(paddedA)
  b.copy(paddedB)
  return timingSafeEqual(paddedA, paddedB) && a.length === b.length
}

export function extractToken(req: IncomingMessage): string {
  const header = req.headers.authorization
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match) return match[1].trim()
  }
  const direct = req.headers['x-api-token']
  if (typeof direct === 'string') return direct.trim()
  const url = new URL(req.url || '/', 'http://localhost')
  return url.searchParams.get('token')?.trim() || ''
}

function applyCors(c: RouteContext, origins: string[]) {
  const origin = typeof c.req.headers.origin === 'string' ? c.req.headers.origin : ''
  const allowAll = origins.includes('*')
  if (allowAll) {
    c.set('Access-Control-Allow-Origin', '*')
  } else if (origin && origins.includes(origin)) {
    c.set('Access-Control-Allow-Origin', origin)
    c.set('Vary', 'Origin')
  }
  c.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  c.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Api-Token')
  c.set('Access-Control-Max-Age', '86400')
}

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name)
  if (raw == null || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.floor(value), min), max)
}

async function handleMembers(ctx: Context, config: Config, url: URL) {
  const groupId = url.searchParams.get('groupId')?.trim()
  const keyword = url.searchParams.get('keyword')?.trim()
  const role = url.searchParams.get('role')?.trim()
  const limit = intParam(url, 'limit', config.pageSize, 1, 1000)
  const offset = intParam(url, 'offset', 0, 0, Number.MAX_SAFE_INTEGER)

  const query: Record<string, any> = {}
  if (groupId) query.groupId = groupId
  if (role) query.role = role
  if (keyword) {
    query.$or = [
      { nickname: { $regex: keyword } },
      { card: { $regex: keyword } },
      { userId: { $regex: keyword } },
    ]
  }

  const rows = await ctx.database.get('qq_group_member', query, {
    limit,
    offset,
    sort: { groupId: 'asc', userId: 'asc' },
  })
  const all = await ctx.database.get('qq_group_member', query, ['userId'])
  return {
    total: all.length,
    limit,
    offset,
    items: rows,
  }
}

async function handleGroups(ctx: Context) {
  const snapshots = await ctx.database.get('qq_group_snapshot', {}, { sort: { groupId: 'asc' } })
  return { total: snapshots.length, items: snapshots }
}

async function handleMember(ctx: Context, url: URL) {
  const groupId = url.searchParams.get('groupId')?.trim()
  const userId = url.searchParams.get('userId')?.trim()
  if (!groupId || !userId) return { status: 400, body: { error: 'groupId and userId are required' } }
  const rows = await ctx.database.get('qq_group_member', { groupId, userId }, { limit: 1 })
  if (!rows.length) return { status: 404, body: { error: 'member not found' } }
  return { status: 200, body: rows[0] }
}

/** Mounts the API on Koishi's own server service, so it starts and stops with Koishi. */
export function registerRoutes(ctx: ServerContext, api: ApiContext) {
  const { config } = api

  if (!config.token) {
    logger.warn('api token is empty; HTTP API disabled')
    return
  }

  const respond = (c: RouteContext, status: number, body: unknown) => {
    c.status = status
    c.body = body
  }

  const guard = (handler: (c: RouteContext, url: URL) => Promise<void> | void) => {
    return async (c: RouteContext) => {
      applyCors(c, config.allowOrigins)
      if (!tokenMatches(config.token, extractToken(c.req))) {
        respond(c, 401, { error: 'unauthorized', hint: 'append ?token=<token> or use Authorization: Bearer <token>' })
        return
      }
      const url = new URL(c.req.url || '/', `http://${c.req.headers.host || 'localhost'}`)
      try {
        await handler(c, url)
      } catch (error) {
        logger.warn(`request failed: ${String(error)}`)
        respond(c, 500, { error: String(error) })
      }
    }
  }

  ctx.server.get('/health', (c: RouteContext) => {
    applyCors(c, config.allowOrigins)
    respond(c, 200, { service: 'group-members-export', ok: true, docs: `${c.origin}/docs` })
  })

  ctx.server.get('/docs', (c: RouteContext) => {
    applyCors(c, config.allowOrigins)
    c.set('Content-Type', 'text/html; charset=utf-8')
    c.body = renderDocs(config, c.origin)
  })

  ctx.server.options(/^\/api(?:\/|$)/, (c: RouteContext) => {
    applyCors(c, config.allowOrigins)
    c.status = 204
    c.body = null
  })

  ctx.server.get('/api/groups', guard(async (c) => {
    respond(c, 200, await handleGroups(ctx))
  }))

  ctx.server.get('/api/members', guard(async (c, url) => {
    respond(c, 200, await handleMembers(ctx, config, url))
  }))

  ctx.server.get('/api/member', guard(async (c, url) => {
    const result = await handleMember(ctx, url)
    respond(c, result.status, result.body)
  }))

  ctx.server.post('/api/collect', guard(async (c) => {
    respond(c, 200, await api.collectNow())
  }))

  logger.info('HTTP API mounted on koishi server: /api/groups, /api/members, /api/member, /api/collect')
}

function renderDocs(config: Config, origin: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>QQ 群成员导出 API</title>
<style>
  body { font-family: "Microsoft YaHei UI", "Microsoft YaHei", sans-serif; max-width: 880px; margin: 40px auto; padding: 0 20px; line-height: 1.7; color: #23282d; }
  h1 { border-bottom: 2px solid #eee; padding-bottom: 12px; }
  code, pre { background: #f6f8fa; border-radius: 6px; font-family: Consolas, monospace; }
  code { padding: 2px 6px; }
  pre { padding: 14px; overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; margin: 16px 0; }
  th, td { border: 1px solid #e1e4e8; padding: 8px 12px; text-align: left; }
  th { background: #f6f8fa; }
  .method { display: inline-block; padding: 1px 8px; border-radius: 4px; font-size: 12px; color: #fff; margin-right: 8px; }
  .get { background: #2f9e63; } .post { background: #1f6feb; }
</style>
</head>
<body>
<h1>QQ 群成员导出 API</h1>
<p>启动后每 <b>${config.intervalMinutes}</b> 分钟自动抓取一次配置群聊的全部成员。<br>
接口挂在 Koishi 的 server 服务上，随 Koishi 一起启动，基础地址：<code>${origin}</code></p>

<h2>鉴权</h2>
<p>除 <code>/health</code>、<code>/docs</code> 外，所有接口必须携带令牌。推荐直接拼在 URL 参数里：</p>
<pre>?token=&lt;token&gt;</pre>
<p>也支持 <code>Authorization: Bearer &lt;token&gt;</code> 与 <code>X-Api-Token: &lt;token&gt;</code> 请求头。令牌在插件配置的 <code>token</code> 项中设置；缺失或错误返回 <code>401</code>。</p>

<h2>接口</h2>

<h3><span class="method get">GET</span>/api/groups</h3>
<p>返回已采集的群列表及最近一次采集的成员数。</p>
<pre>curl "${origin}/api/groups?token=&lt;token&gt;"</pre>

<h3><span class="method get">GET</span>/api/members</h3>
<p>分页查询群成员。</p>
<table>
  <tr><th>参数</th><th>类型</th><th>说明</th></tr>
  <tr><td>groupId</td><td>string</td><td>可选，按群号过滤</td></tr>
  <tr><td>keyword</td><td>string</td><td>可选，模糊匹配 QQ 号 / 昵称 / 群昵称</td></tr>
  <tr><td>role</td><td>string</td><td>可选，<code>owner</code> / <code>admin</code> / <code>member</code></td></tr>
  <tr><td>limit</td><td>number</td><td>每页条数，默认 ${config.pageSize}，上限 1000</td></tr>
  <tr><td>offset</td><td>number</td><td>偏移量，默认 0</td></tr>
</table>
<pre>curl "${origin}/api/members?token=&lt;token&gt;&amp;groupId=123456&amp;limit=50"</pre>

<h3><span class="method get">GET</span>/api/member</h3>
<p>查询单个成员，<code>groupId</code> 与 <code>userId</code> 均必填。</p>
<pre>curl "${origin}/api/member?token=&lt;token&gt;&amp;groupId=123456&amp;userId=10001"</pre>

<h3><span class="method post">POST</span>/api/collect</h3>
<p>立即触发一次全量采集（不等定时任务），返回群数与成员数。</p>
<pre>curl -X POST "${origin}/api/collect?token=&lt;token&gt;"</pre>

<h2>错误响应</h2>
<pre>{ "error": "unauthorized", "hint": "append ?token=<token> or use Authorization: Bearer <token>" }</pre>
</body>
</html>`
}
