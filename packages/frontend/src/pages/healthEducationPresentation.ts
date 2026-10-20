import type { HealthEducationDoctor, HealthEducationItemWithStats } from '@health-agent/shared'

export type HealthEducationThumbnailVariant = 'none' | 'thumbnail' | 'poster'

export interface HealthEducationCardPreview {
  format: string
  previewText: string | null
  thumbnailUrl: string | null
  thumbnailVariant: HealthEducationThumbnailVariant
}

export function formatHealthEducationDoctorMeta(doctor: HealthEducationDoctor): string {
  return [doctor.department, doctor.title, doctor.hospital]
    .map((value) => value?.trim())
    .filter(Boolean)
    .join(' · ')
}

export function healthEducationFormat(item: HealthEducationItemWithStats): string {
  return item.contentFormat?.trim() || '医生说'
}

export function getHealthEducationCardPreview(item: HealthEducationItemWithStats): HealthEducationCardPreview {
  const format = healthEducationFormat(item)
  const thumbnailUrl = item.coverUrl ?? item.imageUrls[0] ?? null
  return {
    format,
    previewText: item.summary?.trim() || null,
    thumbnailUrl,
    thumbnailVariant: thumbnailUrl ? (format === '海报' ? 'poster' : 'thumbnail') : 'none',
  }
}

function normalizeMarkdownTitle(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

export function getHealthEducationDetailMarkdown(item: HealthEducationItemWithStats): string {
  const content = item.content.trimStart()
  const firstLineEnd = content.search(/\r?\n/)
  const firstLine = firstLineEnd >= 0 ? content.slice(0, firstLineEnd) : content
  const match = firstLine.match(/^#\s+(.+?)\s*#*$/)
  if (!match) return item.content

  const markdownTitle = normalizeMarkdownTitle(match[1] ?? '')
  const pageTitle = normalizeMarkdownTitle(item.title)
  if (markdownTitle !== pageTitle) return item.content

  const rest = firstLineEnd >= 0 ? content.slice(firstLineEnd).replace(/^\r?\n+/, '') : ''
  return rest
}

export function mergeHealthEducationItemForList(
  listItem: HealthEducationItemWithStats,
  detailItem: HealthEducationItemWithStats,
): HealthEducationItemWithStats {
  return {
    ...listItem,
    ...detailItem,
    doctor: {
      ...detailItem.doctor,
      department: listItem.doctor.department,
      title: listItem.doctor.title,
      hospital: listItem.doctor.hospital,
    },
    summary: listItem.summary,
    imageUrls: listItem.imageUrls,
    coverUrl: listItem.coverUrl,
    posterContent: detailItem.posterContent ?? listItem.posterContent,
  }
}

export function mergeHealthEducationItemForDetail(
  listItem: HealthEducationItemWithStats,
  detailItem: HealthEducationItemWithStats,
): HealthEducationItemWithStats {
  return {
    ...listItem,
    ...detailItem,
    summary: detailItem.summary ?? listItem.summary,
    content: detailItem.content.trim() ? detailItem.content : '',
    imageUrls: detailItem.imageUrls,
    coverUrl: detailItem.coverUrl ?? null,
    posterContent: detailItem.posterContent ?? listItem.posterContent,
  }
}
