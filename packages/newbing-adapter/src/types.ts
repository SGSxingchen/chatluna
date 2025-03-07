// https://github.com/chathub-dev/chathub/blob/main/src/app/bots/bing/types.ts

import { ClientConfig } from 'koishi-plugin-chatluna/llm-core/platform/config'

export enum BingConversationStyle {
    Creative = 'Creative',
    Balanced = 'Balanced',
    Precise = 'Precise'
}

export interface ConversationResponse {
    conversationId: string
    clientId: string
    conversationSignature: string
    accessToken?: string
    result: {
        value: string
        message: null
    }
}

export enum InvocationEventType {
    Invocation = 1,
    StreamItem = 2,
    Completion = 3,
    StreamInvocation = 4,
    CancelInvocation = 5,
    Ping = 6,
    Close = 7
}

// https://github.com/bytemate/bingchat-api/blob/main/src/lib.ts

export interface ConversationInfo {
    conversationId: string
    clientId: string
    conversationSignature: string
    invocationId: number
    accessToken?: string
    conversationStyle: BingConversationStyle
    maxNumUserMessagesInConversation?: number
}

export interface BingChatResponse {
    conversationSignature: string
    conversationId: string
    clientId: string
    invocationId: number
    conversationExpiryTime: Date
    response: string
    details: ChatResponseMessage
}

export interface ChatResponseMessage {
    spokenText?: string
    text: string
    author: string
    createdAt: Date
    timestamp: Date
    messageId: string
    messageType?: string
    requestId: string
    offense: string
    adaptiveCards: AdaptiveCard[]
    sourceAttributions: SourceAttribution[]
    feedback: Feedback
    contentOrigin: string
    privacy: null
    suggestedResponses: SuggestedResponse[]
}

export interface AdaptiveCard {
    type: string
    version: string
    body: Body[]
}

export interface Body {
    type: string
    text: string
    wrap: boolean
    size?: string
}

export interface Feedback {
    tag: null
    updatedOn: null
    type: string
}

export interface SourceAttribution {
    providerDisplayName: string
    seeMoreUrl: string
    searchQuery: string
}

export interface SuggestedResponse {
    text: string
    author: string
    createdAt: Date
    timestamp: Date
    messageId: string
    messageType: string
    offense: string
    feedback: Feedback
    contentOrigin: string
    privacy: null
}

export interface BingChatMessage {
    author: string
    description?: string
    contextType?: string
    messageType?: string
    messageId?: string
    text?: string
}

export interface BingClientConfig extends ClientConfig {
    sydney: boolean
    search: boolean
}

export function generateMarkdown(response: BingChatResponse) {
    // change `[^Number^]` to markdown link
    const regex = /\[\^(\d+)\^\]/g
    const markdown = response.details.text.replace(regex, (match, p1) => {
        const sourceAttribution =
            response.details.sourceAttributions[Number(p1) - 1]
        return `[${sourceAttribution.providerDisplayName}](${sourceAttribution.seeMoreUrl})`
    })
    return markdown
}
