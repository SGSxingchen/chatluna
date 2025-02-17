import { AIMessage, HumanMessage } from '@langchain/core/messages'
import fs from 'fs'
import {
    Awaitable,
    Computed,
    Context,
    Dict,
    Schema,
    Service,
    Session
} from 'koishi'
import { ChatInterface } from 'koishi-plugin-chatluna/llm-core/chat/app'
import path from 'path'
import { LRUCache } from 'lru-cache'
import { v4 as uuidv4 } from 'uuid'
import { Cache } from '../cache'
import { ChatChain } from '../chains/chain'
import {
    ChatHubLLMChainWrapper,
    SystemPrompts
} from 'koishi-plugin-chatluna/llm-core/chain/base'
import { BasePlatformClient } from 'koishi-plugin-chatluna/llm-core/platform/client'
import {
    ClientConfig,
    ClientConfigPool,
    ClientConfigPoolMode
} from 'koishi-plugin-chatluna/llm-core/platform/config'
import {
    ChatHubBaseEmbeddings,
    ChatLunaChatModel
} from 'koishi-plugin-chatluna/llm-core/platform/model'
import { PlatformService } from 'koishi-plugin-chatluna/llm-core/platform/service'
import {
    ChatHubTool,
    CreateChatHubLLMChainParams,
    CreateVectorStoreFunction,
    ModelType,
    PlatformClientNames
} from 'koishi-plugin-chatluna/llm-core/platform/types'
import {
    formatPresetTemplate,
    PresetTemplate
} from 'koishi-plugin-chatluna/llm-core/prompt'
import { parseRawModelName } from 'koishi-plugin-chatluna/llm-core/utils/count_tokens'
import { PresetService } from 'koishi-plugin-chatluna/preset'
import { ConversationRoom, Message } from '../types'
import {
    ChatLunaError,
    ChatLunaErrorCode
} from 'koishi-plugin-chatluna/utils/error'
import { RequestIdQueue } from 'koishi-plugin-chatluna/utils/queue'
import { MessageTransformer } from './message_transform'
import { ChatEvents } from './types'
import { chatLunaFetch, ws } from 'koishi-plugin-chatluna/utils/request'
import * as fetchType from 'undici/types/fetch'
import { ClientOptions, WebSocket } from 'ws'
import { ClientRequestArgs } from 'http'
import { Config } from '../config'

export class ChatLunaService extends Service {
    private _plugins: Record<string, ChatLunaPlugin> = {}
    private _chatInterfaceWrapper: Record<string, ChatInterfaceWrapper> = {}
    private readonly _chain: ChatChain
    private readonly _keysCache: Cache<'chathub/keys', string>
    private readonly _preset: PresetService
    private readonly _platformService: PlatformService
    private readonly _messageTransformer: MessageTransformer

    constructor(
        public readonly ctx: Context,
        public config: Config
    ) {
        super(ctx, 'chatluna')
        this._chain = new ChatChain(ctx, config)
        this._keysCache = new Cache(this.ctx, config, 'chathub/keys')
        this._preset = new PresetService(ctx, config, this._keysCache)
        this._platformService = new PlatformService(ctx)
        this._messageTransformer = new MessageTransformer()

        this._createTempDir()
        this._defineDatabase()
    }

    async registerPlugin(plugin: ChatLunaPlugin) {
        const platformName = plugin.platformName

        if (this._plugins[platformName]) {
            throw new ChatLunaError(
                ChatLunaErrorCode.PLUGIN_ALREADY_REGISTERED,
                new Error(`Plugin ${platformName} already registered`)
            )
        }

        this._plugins[platformName] = plugin

        this.logger.success(`register plugin %c`, plugin.platformName)
    }

    awaitLoadPlatform(plugin: ChatLunaPlugin | string) {
        const pluginName =
            typeof plugin === 'string' ? plugin : plugin.platformName

        return new Promise((resolve) => {
            const timer = setInterval(() => {
                const targetModels = this._platformService.getModels(
                    pluginName,
                    ModelType.all
                )

                if (
                    targetModels.length > 0 ||
                    this._platformService.getConfigs(pluginName)?.length > 0
                ) {
                    clearInterval(timer)
                    resolve(undefined)
                }
            }, 10)
        })
    }

    unregisterPlugin(
        plugin: ChatLunaPlugin | string,
        withError: boolean = true
    ) {
        const platformName =
            typeof plugin === 'string' ? plugin : plugin.platformName

        const targetPlugin = this._plugins[platformName]

        if (!targetPlugin && withError) {
            throw new ChatLunaError(
                ChatLunaErrorCode.PLUGIN_NOT_FOUND,
                new Error(`Plugin ${platformName} not found`)
            )
        } else if (!targetPlugin) {
            return
        }

        const platform = targetPlugin.platformName

        this._chatInterfaceWrapper[platform]?.dispose()

        delete this._chatInterfaceWrapper[platform]

        targetPlugin.dispose()

        delete this._plugins[platform]

        this.logger.success('unregister plugin %c', targetPlugin.platformName)
    }

    getPlugin(platformName: string) {
        return this._plugins[platformName]
    }

    chat(
        session: Session,
        room: ConversationRoom,
        message: Message,
        event: ChatEvents,
        stream: boolean = false,
        systemPrompts?: SystemPrompts,
        requestId: string = uuidv4()
    ) {
        const { model: modelName } = room

        // provider
        const [platform] = parseRawModelName(modelName)

        const chatInterfaceWrapper =
            this._chatInterfaceWrapper[platform] ??
            this._createChatInterfaceWrapper(platform)

        return chatInterfaceWrapper.chat(
            session,
            room,
            message,
            event,
            stream,
            requestId,
            systemPrompts
        )
    }

    async stopChat(room: ConversationRoom, requestId: string) {
        const chatInterfaceWrapper = this.queryInterfaceWrapper(room, false)

        if (chatInterfaceWrapper == null) {
            return undefined
        }

        return chatInterfaceWrapper.stopChat(requestId)
    }

    queryInterfaceWrapper(room: ConversationRoom, autoCreate: boolean = true) {
        const { model: modelName } = room

        // provider
        const [platform] = parseRawModelName(modelName)

        return (
            this._chatInterfaceWrapper[platform] ??
            (autoCreate
                ? this._createChatInterfaceWrapper(platform)
                : undefined)
        )
    }

    async clearChatHistory(room: ConversationRoom) {
        const { model: modelName } = room

        // provider
        const [platformName] = parseRawModelName(modelName)

        const chatBridger =
            this._chatInterfaceWrapper[platformName] ??
            this._createChatInterfaceWrapper(platformName)

        return chatBridger.clearChatHistory(room)
    }

    getCachedInterfaceWrappers() {
        return Object.values(this._chatInterfaceWrapper)
    }

    async clearCache(room: ConversationRoom) {
        const { model: modelName } = room

        // provider
        const [platformName] = parseRawModelName(modelName)

        const chatBridger =
            this._chatInterfaceWrapper[platformName] ??
            this._createChatInterfaceWrapper(platformName)

        return chatBridger.clear(room)
    }

    async createChatModel(platformName: string, model: string) {
        const service = this._platformService

        const client = await service.randomClient(platformName)

        if (client == null) {
            throw new ChatLunaError(
                ChatLunaErrorCode.MODEL_ADAPTER_NOT_FOUND,
                new Error(`The platform ${platformName} no available`)
            )
        }

        return client.createModel(model)
    }

    async createEmbeddings(platformName: string, modelName: string) {
        const service = this._platformService

        const client = await service.randomClient(platformName)

        if (client == null) {
            throw new ChatLunaError(
                ChatLunaErrorCode.MODEL_ADAPTER_NOT_FOUND,
                new Error(`The platform ${platformName} no available`)
            )
        }

        const model = client.createModel(modelName)

        if (model instanceof ChatHubBaseEmbeddings) {
            return model
        }

        throw new ChatLunaError(
            ChatLunaErrorCode.MODEL_NOT_FOUND,
            new Error(`The model ${modelName} is not embeddings`)
        )
    }

    get platform() {
        return this._platformService
    }

    get cache() {
        return this._keysCache
    }

    get preset() {
        return this._preset
    }

    get chatChain() {
        return this._chain
    }

    get messageTransformer() {
        return this._messageTransformer
    }

    protected async stop(): Promise<void> {
        for (const plugin of Object.values(this._plugins)) {
            this.unregisterPlugin(plugin, false)
        }
    }

    private _createTempDir() {
        // create dir data/chathub/temp use fs
        // ?
        const tempPath = path.resolve(this.ctx.baseDir, 'data/chathub/temp')
        if (!fs.existsSync(tempPath)) {
            fs.mkdirSync(tempPath, { recursive: true })
        }
    }

    private _defineDatabase() {
        const ctx = this.ctx

        ctx.database.extend(
            'chathub_conversation',
            {
                id: {
                    type: 'char',
                    length: 255
                },
                latestId: {
                    type: 'char',
                    length: 255,
                    nullable: true
                },
                additional_kwargs: {
                    type: 'text',
                    nullable: true
                },
                updatedAt: {
                    type: 'timestamp',
                    nullable: false,
                    initial: new Date()
                }
            },
            {
                autoInc: false,
                primary: 'id',
                unique: ['id']
            }
        )

        ctx.database.extend(
            'chathub_message',
            {
                id: {
                    type: 'char',
                    length: 255
                },
                text: 'text',
                parent: {
                    type: 'char',
                    length: 255,
                    nullable: true
                },
                role: {
                    type: 'char',
                    length: 20
                },
                conversation: {
                    type: 'char',
                    length: 255
                },
                additional_kwargs: {
                    type: 'text',
                    nullable: true
                }
            },
            {
                autoInc: false,
                primary: 'id',
                unique: ['id']
                /*  foreign: {
                 conversation: ['chathub_conversaion', 'id']
             } */
            }
        )

        ctx.database.extend(
            'chathub_room',
            {
                roomId: {
                    type: 'integer'
                },
                roomName: 'string',
                conversationId: {
                    type: 'char',
                    length: 255,
                    nullable: true
                },

                roomMasterId: {
                    type: 'char',
                    length: 255
                },
                visibility: {
                    type: 'char',
                    length: 20
                },
                preset: {
                    type: 'char',
                    length: 255
                },
                model: {
                    type: 'char',
                    length: 100
                },
                chatMode: {
                    type: 'char',
                    length: 20
                },
                password: {
                    type: 'char',
                    length: 100
                },
                autoUpdate: {
                    type: 'boolean',
                    initial: true
                },
                updatedTime: {
                    type: 'timestamp',
                    nullable: false,
                    initial: new Date()
                }
            },
            {
                autoInc: false,
                primary: 'roomId',
                unique: ['roomId']
            }
        )

        ctx.database.extend(
            'chathub_room_member',
            {
                userId: {
                    type: 'char',
                    length: 255
                },
                roomId: {
                    type: 'integer'
                },
                roomPermission: {
                    type: 'char',
                    length: 50
                },
                mute: {
                    type: 'boolean',
                    initial: false
                }
            },
            {
                autoInc: false,
                primary: ['userId', 'roomId']
            }
        )

        ctx.database.extend(
            'chathub_room_group_member',
            {
                groupId: {
                    type: 'char',
                    length: 255
                },
                roomId: {
                    type: 'integer'
                },
                roomVisibility: {
                    type: 'char',
                    length: 20
                }
            },
            {
                autoInc: false,
                primary: ['groupId', 'roomId']
            }
        )

        ctx.database.extend(
            'chathub_user',
            {
                userId: {
                    type: 'char',
                    length: 255
                },
                defaultRoomId: {
                    type: 'integer'
                },
                groupId: {
                    type: 'char',
                    length: 255,
                    nullable: true
                }
            },
            {
                autoInc: false,
                primary: ['userId', 'groupId']
            }
        )
    }

    private _createChatInterfaceWrapper(
        platform: string
    ): ChatInterfaceWrapper {
        const chatBridger = new ChatInterfaceWrapper(this)
        this.ctx.logger.debug(`platform %c`, platform)
        this._chatInterfaceWrapper[platform] = chatBridger
        return chatBridger
    }

    static inject = ['cache', 'database']
}

export class ChatLunaPlugin<
    R extends ClientConfig = ClientConfig,
    T extends ChatLunaPlugin.Config = ChatLunaPlugin.Config
> {
    private _disposables: (() => void)[] = []

    private _supportModels: string[] = []

    private readonly _platformConfigPool: ClientConfigPool<R>

    private _platformService: PlatformService

    constructor(
        protected ctx: Context,
        public readonly config: T,
        public platformName: PlatformClientNames,
        createConfigPool: boolean = true
    ) {
        ctx.once('dispose', async () => {
            ctx.chatluna.unregisterPlugin(this, false)
        })

        // inject to root ctx
        ctx.runtime.inject['cache'] = {
            required: true
        }

        if (createConfigPool) {
            this._platformConfigPool = new ClientConfigPool<R>(
                ctx,
                config.configMode === 'default'
                    ? ClientConfigPoolMode.AlwaysTheSame
                    : ClientConfigPoolMode.LoadBalancing
            )
        }

        this._platformService = ctx.chatluna.platform
    }

    async parseConfig(f: (config: T) => R[]) {
        const configs = f(this.config)

        for (const config of configs) {
            await this._platformConfigPool.addConfig(config)
        }
    }

    async initClients() {
        this._platformService.registerConfigPool(
            this.platformName,
            this._platformConfigPool
        )

        try {
            await this._platformService.createClients(this.platformName)
        } catch (e) {
            this.ctx.chatluna.unregisterPlugin(this)

            throw e
        }

        this._supportModels = this._supportModels.concat(
            this._platformService
                .getModels(this.platformName, ModelType.llm)
                .map((model) => `${this.platformName}/${model.name}`)
        )
    }

    async initClientsWithPool<A extends ClientConfig = R>(
        platformName: PlatformClientNames,
        pool: ClientConfigPool<A>,
        createConfigFunc: (config: T) => A[]
    ) {
        const configs = createConfigFunc(this.config)

        for (const config of configs) {
            await pool.addConfig(config)
        }

        this._platformService.registerConfigPool(platformName, pool)

        try {
            await this._platformService.createClients(this.platformName)
        } catch (e) {
            this.ctx.chatluna.unregisterPlugin(this)

            throw e
        }

        this._supportModels = this._supportModels.concat(
            this._platformService
                .getModels(platformName, ModelType.llm)
                .map((model) => `${platformName}/${model.name}`)
        )
    }

    get supportedModels(): readonly string[] {
        return this._supportModels
    }

    dispose() {
        while (this._disposables.length > 0) {
            const disposable = this._disposables.pop()
            disposable()
        }
    }

    registerConfigPool(
        platformName: PlatformClientNames,
        configPool: ClientConfigPool
    ) {
        this._platformService.registerConfigPool(platformName, configPool)
    }

    registerToService() {
        this.ctx.chatluna.registerPlugin(this)
    }

    registerClient(
        func: (
            ctx: Context,
            config: R
        ) => BasePlatformClient<R, ChatHubBaseEmbeddings | ChatLunaChatModel>,
        platformName: string = this.platformName
    ) {
        const disposable = this._platformService.registerClient(
            platformName,
            func
        )

        this._disposables.push(disposable)
    }

    registerVectorStore(name: string, func: CreateVectorStoreFunction) {
        const disposable = this._platformService.registerVectorStore(name, func)
        this._disposables.push(disposable)
    }

    registerTool(name: string, tool: ChatHubTool) {
        const disposable = this._platformService.registerTool(name, tool)
        this._disposables.push(disposable)
    }

    registerChatChainProvider(
        name: string,
        description: Dict<string>,
        func: (
            params: CreateChatHubLLMChainParams
        ) => Promise<ChatHubLLMChainWrapper>
    ) {
        const disposable = this._platformService.registerChatChain(
            name,
            description,
            func
        )
        this._disposables.push(disposable)
    }

    async fetch(info: fetchType.RequestInfo, init?: fetchType.RequestInit) {
        const proxyMode = this.config.proxyMode

        switch (proxyMode) {
            case 'system':
                return chatLunaFetch(info, init)
            case 'off':
                return chatLunaFetch(info, init, 'null')
            case 'on':
                return chatLunaFetch(info, init, this.config.proxyAddress)
            default:
                return chatLunaFetch(info, init)
        }
    }

    ws(url: string, options?: ClientOptions | ClientRequestArgs): WebSocket {
        const proxyMode = this.config.proxyMode

        switch (proxyMode) {
            case 'system':
                return ws(url, options)
            case 'off':
                return ws(url, options, 'null')
            case 'on':
                return ws(url, options, this.config.proxyAddress)
            default:
                return ws(url, options)
        }
    }
}

type ChatHubChatBridgerInfo = {
    chatInterface: ChatInterface
    presetTemplate: PresetTemplate
    room: ConversationRoom
}

class ChatInterfaceWrapper {
    private _conversations: LRUCache<string, ChatHubChatBridgerInfo> =
        new LRUCache({
            max: 10
        })

    private _modelQueue = new RequestIdQueue()
    private _conversationQueue = new RequestIdQueue()
    private _platformService: PlatformService

    private _requestIdMap: Map<string, AbortController> = new Map()

    constructor(private _service: ChatLunaService) {
        this._platformService = _service.platform
    }

    async chat(
        session: Session,
        room: ConversationRoom,
        message: Message,
        event: ChatEvents,
        stream: boolean,
        requestId: string,
        systemPrompts?: SystemPrompts
    ): Promise<Message> {
        const { conversationId, model: fullModelName } = room

        const [platform] = parseRawModelName(fullModelName)

        const config = this._platformService.getConfigs(platform)[0]

        const maxQueueLength = config.value.concurrentMaxSize
        const currentQueueLength =
            await this._modelQueue.getQueueLength(platform)

        await this._conversationQueue.add(conversationId, requestId)
        await this._modelQueue.add(platform, requestId)

        await event['llm-queue-waiting'](currentQueueLength)

        await this._modelQueue.wait(platform, requestId, maxQueueLength)

        const abortController = new AbortController()
        this._requestIdMap.set(requestId, abortController)

        try {
            const { chatInterface } =
                this._conversations.get(conversationId) ??
                (await this._createChatInterface(room))

            const humanMessage = new HumanMessage({
                content: message.content,
                name: message.name,
                additional_kwargs: message.additional_kwargs
            })

            const chainValues = await chatInterface.chat({
                message: humanMessage,
                events: event,
                stream,
                conversationId,
                session,
                systemPrompts,
                signal: abortController.signal
            })

            return {
                content: (chainValues.message as AIMessage).content as string,
                additionalReplyMessages: (
                    chainValues.additionalReplyMessages as string[]
                )?.map((content) => ({
                    content
                }))
            }
        } finally {
            await this._modelQueue.remove(platform, requestId)
            await this._conversationQueue.remove(conversationId, requestId)
            this._requestIdMap.delete(requestId)
        }
    }

    stopChat(requestId: string) {
        const abortController = this._requestIdMap.get(requestId)
        if (!abortController) {
            return false
        }
        abortController.abort()
        return true
    }

    async query(room: ConversationRoom): Promise<ChatInterface> {
        const { conversationId } = room

        const { chatInterface } =
            this._conversations.get(conversationId) ??
            (await this._createChatInterface(room))

        return chatInterface
    }

    async clearChatHistory(room: ConversationRoom) {
        const { conversationId } = room

        const chatInterface = await this.query(room)

        if (chatInterface == null) {
            return
        }

        const requestId = uuidv4()
        await this._conversationQueue.wait(conversationId, requestId, 0)
        await chatInterface.clearChatHistory()
        this._conversations.delete(conversationId)
        await this._conversationQueue.remove(conversationId, requestId)
    }

    async clear(room: ConversationRoom | string) {
        let conversationId: string

        if (typeof room === 'string') {
            conversationId = room
        } else {
            conversationId = room.conversationId
        }

        const requestId = uuidv4()
        await this._conversationQueue.wait(conversationId, requestId, 0)

        this._conversations.delete(conversationId)

        await this._conversationQueue.remove(conversationId, requestId)
    }

    getCacheConversations() {
        return Object.keys(this._conversations).map(
            (conversationId) =>
                [conversationId, this._conversations.get(conversationId)] as [
                    string,
                    ChatHubChatBridgerInfo
                ]
        )
    }

    async delete(room: ConversationRoom) {
        const { conversationId } = room

        const chatInterface = await this.query(room)

        if (chatInterface == null) {
            return
        }

        const requestId = uuidv4()
        await this._conversationQueue.wait(conversationId, requestId, 1)
        await chatInterface.delete(this._service.ctx, room)
        await this._conversationQueue.remove(conversationId, requestId)
        await this.clear(room)
    }

    dispose() {
        this._conversations.clear()
    }

    private async _createChatInterface(
        room: ConversationRoom
    ): Promise<ChatHubChatBridgerInfo> {
        const presetTemplate = await this._service.preset.getPreset(room.preset)

        const config = this._service.config

        const chatInterface = new ChatInterface(this._service.ctx.root, {
            chatMode: room.chatMode,
            historyMode: config.historyMode === 'default' ? 'all' : 'summary',
            botName: config.botName,
            systemPrompts: formatPresetTemplate(presetTemplate, {
                name: config.botName,
                date: new Date().toLocaleString()
            }),
            model: room.model,
            longMemory: config.longMemory,
            longMemorySimilarity: config.longMemorySimilarity,

            conversationId: room.conversationId,
            longMemoryCall: config.longMemoryCall,
            embeddings:
                config.defaultEmbeddings && config.defaultEmbeddings.length > 0
                    ? config.defaultEmbeddings
                    : undefined,
            vectorStoreName:
                config.defaultVectorStore &&
                config.defaultVectorStore.length > 0
                    ? config.defaultVectorStore
                    : undefined,
            maxMessagesCount: config.messageCount
        })

        const result = {
            chatInterface,
            presetTemplate,
            room
        }

        this._conversations.set(room.conversationId, result)

        return result
    }
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace ChatLunaPlugin {
    export interface Config {
        chatConcurrentMaxSize?: number
        chatTimeLimit?: Computed<Awaitable<number>>
        timeout?: number
        configMode: string
        maxRetries: number
        proxyMode: string
        proxyAddress: string
    }

    export const Config: Schema<ChatLunaPlugin.Config> = Schema.intersect([
        Schema.object({
            chatConcurrentMaxSize: Schema.number().min(1).max(8).default(3),
            chatTimeLimit: Schema.union([
                Schema.natural(),
                Schema.any().hidden()
            ])
                .role('computed')
                .default(200),
            configMode: Schema.union([
                Schema.const('default'),
                Schema.const('balance')
            ]).default('default'),
            maxRetries: Schema.number().min(1).max(6).default(3),
            timeout: Schema.number().default(300 * 1000),
            proxyMode: Schema.union([
                Schema.const('system'),
                Schema.const('off'),
                Schema.const('on')
            ]).default('system')
        }),
        Schema.union([
            Schema.object({
                proxyMode: Schema.const('on').required(),
                proxyAddress: Schema.string().default('')
            }),
            Schema.object({})
        ])
    ]).i18n({
        'zh-CN': require('../locales/zh-CN.schema.plugin.yml'),
        'en-US': require('../locales/en-US.schema.plugin.yml')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any

    export const inject = ['cache']
}
