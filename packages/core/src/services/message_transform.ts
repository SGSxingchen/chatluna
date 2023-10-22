import { h, Session } from 'koishi'
import { Message } from '../types'
import { ChatHubError, ChatHubErrorCode } from '../utils/error'
import { createLogger } from '../utils/logger'

const logger = createLogger()

export class MessageTransformer {
    private _transformFunctions: Record<string, MessageTransformFunction> = {}

    constructor() {}

    async transform(
        session: Session,
        elements: h[],
        message: Message = {
            content: '',
            additional_kwargs: {}
        }
    ): Promise<Message> {
        for (const element of elements) {
            const transformFunction = this._transformFunctions[element.type]
            if (transformFunction != null) {
                const result = await transformFunction(
                    session,
                    element,
                    message
                )

                if (result === false && element.children) {
                    await this.transform(session, element.children, message)
                }
            }
        }

        return message
    }

    intercept(type: string, transformFunction: MessageTransformFunction) {
        if (type === 'text' && this._transformFunctions['text'] != null) {
            throw new ChatHubError(
                ChatHubErrorCode.UNKNOWN_ERROR,
                new Error('text transform function already exists')
            )
        }

        if (
            this._transformFunctions[type] != null &&
            !['image'].includes(type)
        ) {
            logger.warn(
                `transform function for ${type} already exists. Check your installed plugins.`
            )
        }

        this._transformFunctions[type] = transformFunction
    }
}

export type MessageTransformFunction = (
    session: Session,
    element: h,
    message: Message
) => Promise<boolean | void>
