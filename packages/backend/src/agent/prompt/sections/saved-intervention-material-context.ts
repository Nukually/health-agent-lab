import type { SavedInterventionMaterialPromptSummary } from '../../../services/intervention-material-engagement.js'
import type {
  InterventionCatalogCodeEntry,
  InterventionRuntimeCatalogSnapshot,
} from '../../../services/intervention-material-runtime.js'

const UPDATE_TIME_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

function formatShanghaiMinute(iso: string | null): string {
  if (!iso) return '无记录'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso

  const parts = Object.fromEntries(
    UPDATE_TIME_FMT.formatToParts(date).map((part) => [part.type, part.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

function formatDuration(totalSec: number): string {
  const seconds = Math.max(0, Math.floor(totalSec))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remain = seconds % 60
  return remain > 0 ? `${minutes}m${remain}s` : `${minutes}m`
}

function progressText(completed: number, total: number): string {
  if (total <= 0) return '未记录'
  return `${Math.min(completed, total)}/${total}`
}

function findCatalogEntry(
  item: SavedInterventionMaterialPromptSummary['items'][number],
  catalog: InterventionRuntimeCatalogSnapshot,
): InterventionCatalogCodeEntry | null {
  const byCode = catalog.codeMap.get(item.materialCode)
  if (byCode) return byCode

  for (const group of catalog.groups) {
    const byMaterialId = group.items.find((entry) => entry.materialId === item.materialId)
    if (byMaterialId) return byMaterialId
  }
  return null
}

function renderTitle(
  item: SavedInterventionMaterialPromptSummary['items'][number],
  catalog: InterventionRuntimeCatalogSnapshot,
): string {
  const entry = findCatalogEntry(item, catalog)
  if (!entry) return `干预方案 ${item.materialCode}`
  return `《${entry.actionName}》｜${entry.sideEffect} / ${entry.scene}`
}

function renderSavedInterventionLine(
  item: SavedInterventionMaterialPromptSummary['items'][number],
  catalog: InterventionRuntimeCatalogSnapshot,
  index: number,
): string {
  const followText = item.lastFollowedAt
    ? [
        item.followCompletedAt ? '已完成过跟练' : '已开始跟练',
        `最近跟练：${formatShanghaiMinute(item.lastFollowedAt)}`,
        `进度：${progressText(item.completedStepCount, item.totalStepCount)}`,
        `累计时长：${formatDuration(item.totalFollowSec)}`,
      ].join('｜')
    : '尚未开始跟练'

  return `  ${index + 1}. [${item.materialCode}] ${renderTitle(item, catalog)}｜保存：${formatShanghaiMinute(item.savedAt)}｜${followText}`
}

export function savedInterventionMaterialsContext(
  summary: SavedInterventionMaterialPromptSummary | null | undefined,
  catalog: InterventionRuntimeCatalogSnapshot,
): string {
  const total = summary?.totalCount ?? 0
  const items = summary?.items ?? []
  const lines = [
    '## 已保存跟练卡片',
    `- 总数：${total} 张。`,
    '- 同一干预方案 code 只应保存一张跟练卡。',
  ]

  if (!items.length) {
    lines.push('- 当前暂无已保存跟练卡。')
    return lines.join('\n')
  }

  if (items.length <= 6) {
    lines.push(`- 全部 ${items.length} 张：`)
    items.forEach((item, index) => {
      lines.push(renderSavedInterventionLine(item, catalog, index))
    })
  } else {
    lines.push('- 预览：最近保存的 5 张 + 最早保存的 1 张（中间省略）：')
    items.slice(0, 5).forEach((item, index) => {
      lines.push(renderSavedInterventionLine(item, catalog, index))
    })
    lines.push(`  ... 中间 ${items.length - 6} 张省略`)
    lines.push(renderSavedInterventionLine(items[items.length - 1], catalog, items.length - 1))
  }

  return lines.join('\n')
}
