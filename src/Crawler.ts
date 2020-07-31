import { parse as parseUrl } from 'url'
import { request, cleanup } from 'taki'
import chalk from 'chalk'
import { PromiseQueue } from '@egoist/promise-queue'
import { Writer } from './Writer'
import { Logger } from './Logger'

export const SPECIAL_EXTENSIONS_RE = /\.(xml|json)$/

const routeToFile = (route: string) => {
  if (/\.html$/.test(route) || SPECIAL_EXTENSIONS_RE.test(route)) {
    return route
  }
  return route.replace(/\/?$/, '/index.html')
}

const getHref = (attrs: string) => {
  const match = /href\s*=\s*(?:"(.*?)"|'(.*?)'|([^\s>]*))/.exec(attrs)
  return match && (match[1] || match[2] || match[3])
}

type CrawlerOptions = {
  hostname: string
  port: number
  options: {
    routes: string[] | (() => Promise<string[]>)
  }
  writer: Writer
  logger: Logger
}

export class Crawler {
  opts: CrawlerOptions

  constructor(opts: CrawlerOptions) {
    this.opts = opts
  }

  async crawl() {
    const { hostname, port, options, writer, logger } = this.opts

    const routes =
      typeof options.routes === 'function'
        ? await options.routes()
        : options.routes

    const crawlRoute = async (routes: string[]) => {
      const queue = new PromiseQueue(
        async (route: string) => {
          const file = routeToFile(route)
          const html = await request({
            url: `http://${hostname}:${port}${route}`,
            onBeforeRequest(url) {
              logger.log(`Crawling contents from ${chalk.cyan(url)}`)
            },
            manually: SPECIAL_EXTENSIONS_RE.test(route) ? true : undefined,
            onCreatedPage(page) {
              page.on('console', (e) => {
                const type = e.type()
                // @ts-ignore
                const log = console[type] || console.log
                const location = e.location()
                log(
                  `Message from ${location.url}:${location.lineNumber}:${location.columnNumber}`,
                  e.text()
                )
              })
            },
          })

          // find all `<a>` tags in exported html files and export links that are not yet exported
          let match: RegExpExecArray | null = null
          const LINK_RE = /<a ([\s\S]+?)>/gm
          while ((match = LINK_RE.exec(html))) {
            const href = getHref(match[1])
            if (href) {
              const parsed = parseUrl(href)
              if (!parsed.host && parsed.pathname) {
                queue.add(parsed.pathname)
              }
            }
          }

          logger.log(`Writing ${chalk.cyan(file)} for ${chalk.cyan(route)}`)
          await writer.write({ html, file })
        },
        { maxConcurrent: 50 }
      )
      for (const route of routes) {
        queue.add(route)
      }
      await queue.run()
    }

    await crawlRoute(routes)
    await cleanup()
  }
}
