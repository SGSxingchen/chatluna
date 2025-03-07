import { Tool } from '@langchain/core/tools'
import { Config } from '..'
import { ChatLunaPlugin } from 'koishi-plugin-chatluna/services/chat'
import { PuppeteerBrowserTool } from './puppeteerBrowserTool'
import { Context } from 'koishi'

export abstract class SearchTool extends Tool {
    name = 'web_search'

    // eslint-disable-next-line max-len
    description = `a search engine. useful for when you need to answer questions about current events. input should be a raw string of keyword. About Search Keywords, you should cut what you are searching for into several keywords and separate them with spaces. For example, "What is the weather in Beijing today?" would be "Beijing weather today"`

    constructor(
        protected ctx: Context,
        protected config: Config,
        protected _webBrowser: PuppeteerBrowserTool,
        protected _plugin: ChatLunaPlugin
    ) {
        super({})
    }
}
