/* eslint-disable max-len */
import { Tool } from '@langchain/core/tools'
import { Context, Session } from 'koishi'
import { ChatLunaPlugin } from 'koishi-plugin-chatluna/services/chat'
import {
    fuzzyQuery,
    getMessageContent
} from 'koishi-plugin-chatluna/utils/string'
import { Config } from '..'
import { randomString } from './command'

export async function apply(
    ctx: Context,
    config: Config,
    plugin: ChatLunaPlugin
) {
    if (config.cron !== true) {
        return
    }

    await plugin.registerTool('cron', {
        selector(history) {
            return fuzzyQuery(
                getMessageContent(history[history.length - 1].content),
                [
                    '定时',
                    '任务',
                    '醒',
                    '用',
                    'do',
                    '提示',
                    '秒',
                    '分',
                    '时',
                    '天',
                    '星期',
                    'cron',
                    'task',
                    'command'
                ]
            )
        },
        alwaysRecreate: true,

        async createTool(params, session) {
            return new CronTool(session)
        }
    })
}

export class CronTool extends Tool {
    name = 'cron'

    constructor(public session: Session) {
        super({})
    }

    /** @ignore */
    async _call(input: string) {
        const validationString = randomString(8)
        // echo,10s, "hello","" -> ["echo","10s","hello",""]
        // command,10m, "plugin.install chatgpt" -> ["command","10m","plugin.install chatgpt"]

        const session = this.session

        let [type, interval, ...args] = input.split(',')

        args = args.map((arg) =>
            arg.includes('"') || arg.includes("'") ? arg.slice(1, -1) : arg
        )

        const command = this._generateCommand(type, interval, args)
        // command.session = this.session

        await session.send(
            `模型请求执行定时指令 ${
                command /* .source */
            }，如需同意，请输入以下字符：${validationString}`
        )
        const canRun = await this.session.prompt()

        if (canRun !== validationString) {
            await this.session.send('指令执行失败')
            return `The cron ${input} execution failed, because the user didn't confirm`
        }

        try {
            const result = await session.execute(command, true)
            await session.send(result)
            return result
        } catch (e) {
            return `The cron ${input} execution failed, because ${e.message}`
        }
    }

    private _generateCommand(type: string, interval: string, args: string[]) {
        if (type === 'command') {
            return `schedule ${interval} -- ${args[0]}`
        }

        const result = [`schedule ${interval} -- echo`]

        if (args[1] === 'group') {
            result.push(args[0])
            return result.join(' ')
        }

        if (args[1] == null || args[1].trim().length < 1) {
            args[1] = this.session.event.user.id
        }

        result.push('-u')
        result.push('@' + args[1])
        result.push(args[0])

        return result.join(' ')
    }

    // eslint-disable-next-line max-len
    description = `Runs periodic tasks. Usage: type,time,content[,recipient]

Types:
- command: Executes a command
- echo: Sends a message

Time formats:
- Xm, Xh: After X minutes/hours
- HH:MM: At specific time today
- Xm / Ys: Every Y seconds after X minutes
- HH:MM / Xd: At HH:MM every X days

Content:
- For command: The command to run
- For echo: The message to send

Recipient (echo only):
- Empty: Sender
- 'group': Everyone/group
- User ID: Specific user

Examples:
echo,10s,"Hello",""
command,10m,"plugin.install chatgpt"`
}
