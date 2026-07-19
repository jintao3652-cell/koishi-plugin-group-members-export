import { Context, h, Session } from 'koishi'

export const name = 'group-members-export'
export const inject = ['onebot']

// ==================== 类型定义 ====================
interface GroupInfo {
  group_id: number
  group_name: string
}

interface OneBotMember {
  user_id: number
  nickname: string
  card: string
  role: 'owner' | 'admin' | 'member'
  title: string
  join_time: number
}

interface ExportedMember {
  qq: number
  nickname: string
  card: string
  role: string
  title: string
  join_time: string
}

// ==================== 类型扩展（解决 TS 报错） ====================
declare module 'koishi' {
  interface Context {
    onebot: any
  }

  interface Session {
    onebot: any
  }
}

export function apply(ctx: Context) {
  ctx.command('群成员 <group:string>', '获取群成员列表并导出JSON（支持群号或群名称）')
    .alias('gml', '群员', '导出群成员')
    .option('show', '-s 只显示不导出')
    .action(async ({ session, options }, group: string) => {
      if (!group) {
        return '❌ 请提供群号或群名称'
      }

      if (!session || session.platform !== 'onebot') {
        return '❌ 此命令仅支持 OneBot 平台'
      }

      const onebot = session.onebot
      if (!onebot) {
        return '❌ onebot 服务未加载，请确保 adapter-onebot 已启用并重启 Koishi'
      }

      let groupId: number | null = null

      if (/^\d+$/.test(group)) {
        groupId = parseInt(group, 10)
      } else {
        await session.send('🔍 正在通过群名称查找群号...')
        try {
          const groupList: GroupInfo[] = await onebot.getGroupList()
          if (!groupList?.length) return '❌ 机器人未加入任何群'

          const matched = groupList.filter((g: GroupInfo) => g.group_name.includes(group))
          if (matched.length === 0) return `❌ 未找到名称包含“${group}”的群`

          if (matched.length > 1) {
            const names = matched.map((g: GroupInfo) => `${g.group_name}(${g.group_id})`).join('、')
            await session.send(`⚠️ 找到多个匹配群：${names}\n已使用第一个`)
          }
          groupId = matched[0].group_id
        } catch (err: any) {
          return `❌ 获取群列表失败：${err.message}`
        }
      }

      if (!groupId) return '❌ 无法获取群号'

      await session.send('正在获取群成员列表，请稍等...')

      try {
        const members: OneBotMember[] = await onebot.getGroupMemberList(groupId, true)

        if (!members || members.length === 0) {
          return `❌ 群 ${groupId} 成员列表为空`
        }

        const memberList: ExportedMember[] = members.map((m: OneBotMember) => ({
          qq: m.user_id,
          nickname: m.nickname || '未知',
          card: m.card || m.nickname || '无群昵称',
          role: m.role === 'owner' ? '群主' : m.role === 'admin' ? '管理员' : '成员',
          title: m.title || '',
          join_time: m.join_time ? new Date(m.join_time * 1000).toLocaleString('zh-CN') : '未知'
        }))

        if (options?.show) {
          let text = `群 ${groupId} 成员列表（共 ${memberList.length} 人）\n\n`
          const displayList = memberList.slice(0, 50)
          displayList.forEach((m) => {
            text += `${m.qq} | ${m.card}\n`
          })
          if (memberList.length > 50) text += `\n... 仅显示前 50 人`
          return text
        }

        const jsonStr = JSON.stringify(memberList, null, 2)
        const buffer = Buffer.from(jsonStr, 'utf-8')
        const filename = `群${groupId}_成员列表_${new Date().toISOString().slice(0, 10)}.json`

        return h.file(buffer, 'application/json', { filename })

      } catch (error: any) {
        console.error('[群成员导出]', error)
        return `❌ 获取失败：${error.message}\n可能原因：机器人不是管理员或未加入该群`
      }
    })
}