import { Context } from 'koishi';
import { Config } from '../config';
import { ChainMiddlewareRunStatus, ChatChain } from '../chain';
import { createLogger } from '@dingyi222666/chathub-llm-core/lib/utils/logger';
import { Factory } from '@dingyi222666/chathub-llm-core/lib/chat/factory';
import { preset } from './resolve_preset';

const logger = createLogger("@dingyi222666/chathub/middlewares/set_preset")

export function apply(ctx: Context, config: Config, chain: ChatChain) {
    chain.middleware("reset_preset", async (session, context) => {

        const { command } = context

        if (command !== "resetPreset") return ChainMiddlewareRunStatus.SKIPPED

        const conversationInfo = context.options.conversationInfo

        const presetTemplate = await preset.getDefaultPreset()

        conversationInfo.systemPrompts = presetTemplate.rawText

        await ctx.database.upsert("chathub_conversation_info", [conversationInfo])

        context.message = `已重置会话预设为 ${presetTemplate.triggerKeyword[0]}, 快来和我聊天吧`

        return ChainMiddlewareRunStatus.CONTINUE
    }).before("reset_converstaion")
}

declare module '../chain' {
    interface ChainMiddlewareName {
        "reset_preset": never
    }

  
}