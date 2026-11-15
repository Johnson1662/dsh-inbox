import z from "@deepseek-ai/schemastery"

/**
 * 插件行配置的 schema，只给宿主校验 cordis.patch.yml 里那一段用。
 *
 * **它不生成界面**——DSH 没有 schema→表单的机制（那是 Koishi），
 * 真正的设置面板在 client.js 里手写。别再把这里当成 UI 的来源。
 *
 * 只放"安全"的配置：凭据（telegram apiHash、http token）一律走环境变量，
 * 不进这个文件，也不进设置界面。
 *
 * 字段做成扁平标量而不是嵌套对象，是为了让表单渲染稳定；
 * 由 plugin/index.js 摊回分层结构。
 */
export const Config = z.object({
  stateDir: z.string().default("~/.dsh/state/personal-context").volatile(),
  sink: z.string().default("chief").volatile(),

  intervalMs: z.number().default(500).volatile(),
  batchCount: z.number().default(50).volatile(),
  batchChars: z.number().default(4000).volatile(),
  backlogCount: z.number().default(200).volatile(),
  backlogChars: z.number().default(20000).volatile(),

  telegramEnabled: z.boolean().default(false).volatile(),
  telegramIntervalMs: z.number().default(8000).volatile(),
  feishuEnabled: z.boolean().default(false).volatile(),
  feishuIntervalMs: z.number().default(5000).volatile(),
})
