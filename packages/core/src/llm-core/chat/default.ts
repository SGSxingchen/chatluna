import { Context, Schema } from 'koishi'
import { logger } from 'koishi-plugin-chatluna'
import { PlatformService } from 'koishi-plugin-chatluna/llm-core/platform/service'
import {
    ChatHubTool,
    ModelType
} from 'koishi-plugin-chatluna/llm-core/platform/types'
import { ChatHubChatChain } from '../chain/chat_chain'
import { ChatLunaPluginChain } from '../chain/plugin_chat_chain'

export async function defaultFactory(ctx: Context, service: PlatformService) {
    ctx.on('chatluna/chat-chain-added', (service) => {
        updateChatChains(ctx, service)
    })

    ctx.on('chatluna/chat-chain-removed', (service) => {
        updateChatChains(ctx, service)
    })

    ctx.on('chatluna/model-added', (service) => {
        updateModels(ctx, service)
    })

    ctx.on('chatluna/model-removed', (service) => {
        updateModels(ctx, service)
    })

    ctx.on('chatluna/embeddings-added', (service) => {
        updateEmbeddings(ctx, service)
    })

    ctx.on('chatluna/embeddings-removed', (service) => {
        updateEmbeddings(ctx, service)
    })

    ctx.on('chatluna/vector-store-added', (service) => {
        updateVectorStores(ctx, service)
    })

    ctx.on('chatluna/vector-store-removed', (service) => {
        updateVectorStores(ctx, service)
    })

    ctx.on('chatluna/tool-updated', (service) => {
        for (const wrapper of ctx.chatluna.getCachedInterfaceWrappers()) {
            wrapper
                .getCacheConversations()
                .filter(
                    ([_, conversation]) =>
                        conversation.room.chatMode === 'plugin' ||
                        conversation.room.chatMode === 'browsing'
                )
                .forEach(([id]) => {
                    logger?.debug(`Clearing cache for room ${id}`)
                    wrapper.clear(id)
                })
        }
    })

    service.registerChatChain(
        'chat',
        {
            'zh-CN': '聊天模式',
            'en-US': 'Chat mode'
        },
        async (params) => {
            return ChatHubChatChain.fromLLM(params.model, {
                botName: params.botName,
                longMemory: params.longMemory,
                historyMemory: params.historyMemory,
                systemPrompts: params.systemPrompt
            })
        }
    )

    service.registerChatChain(
        'plugin',
        {
            'zh-CN': '插件模式（基于 LangChain 的 Agent）',
            'en-US': 'Plugin mode (based on LangChain Agent)'
        },
        async (params) => {
            return ChatLunaPluginChain.fromLLMAndTools(
                params.model,
                getTools(service, (_) => true),
                {
                    systemPrompts: params.systemPrompt,
                    historyMemory: params.historyMemory,
                    embeddings: params.embeddings
                }
            )
        }
    )
}

function updateModels(ctx: Context, service: PlatformService) {
    ctx.schema.set('model', Schema.union(getModelNames(service)))
}

function updateChatChains(ctx: Context, service: PlatformService) {
    ctx.schema.set('chat-mode', Schema.union(getChatChainNames(service)))
}

function updateEmbeddings(ctx: Context, service: PlatformService) {
    ctx.schema.set(
        'embeddings',
        Schema.union(getModelNames(service, ModelType.embeddings))
    )
}

function updateVectorStores(ctx: Context, service: PlatformService) {
    const vectorStoreRetrieverNames = service
        .getVectorStoreRetrievers()
        .concat('无')
        .map((name) => Schema.const(name))

    ctx.schema.set('vector-store', Schema.union(vectorStoreRetrieverNames))
}

function getTools(
    service: PlatformService,
    filter: (name: string) => boolean
): ChatHubTool[] {
    const tools = service.getTools().filter(filter)

    return tools.map((name) => service.getTool(name))
}

function getChatChainNames(service: PlatformService) {
    return service
        .getChatChains()
        .map((info) => Schema.const(info.name).i18n(info.description))
}

function getModelNames(
    service: PlatformService,
    type: ModelType = ModelType.llm
) {
    const models = service.getAllModels(type).concat('无')

    return models.map((model) => Schema.const(model).description(model))
}
