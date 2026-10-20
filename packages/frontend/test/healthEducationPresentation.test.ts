import assert from 'node:assert/strict'
import type { HealthEducationItemWithStats } from '@health-agent/shared'
import {
  formatHealthEducationDoctorMeta,
  getHealthEducationCardPreview,
  getHealthEducationDetailMarkdown,
  mergeHealthEducationItemForDetail,
  mergeHealthEducationItemForList,
} from '../src/pages/healthEducationPresentation.js'

function item(overrides: Partial<HealthEducationItemWithStats>): HealthEducationItemWithStats {
  return {
    id: '5',
    posterId: 5,
    status: 'published',
    title: '乳腺癌内分泌治疗依从性管理(图文版)',
    summary: ' 预览描述 ',
    content: '列表预览',
    imageUrls: ['https://example.com/cover.png'],
    coverUrl: 'https://example.com/cover.png',
    doctor: {
      id: '',
      name: '渠源',
      avatarUrl: null,
      department: null,
      title: '主管技师',
      hospital: '浙江大学第一附属医院',
    },
    publishedAt: '2026-05-22T14:07:16.440584+08:00',
    updatedAt: '2026-05-22T14:07:16.440584+08:00',
    tags: [],
    drug: '他莫昔芬',
    contentFormat: '图文',
    taskType: null,
    posterContent: null,
    isAvailable: true,
    likeCount: 0,
    dislikeCount: 0,
    favoriteCount: 0,
    pvCount: 0,
    uvCount: 0,
    userReaction: null,
    isFavorited: false,
    ...overrides,
  }
}

{
  assert.equal(
    formatHealthEducationDoctorMeta({
      id: 'doctor-1',
      name: '渠源',
      avatarUrl: null,
      department: '乳腺外科',
      title: '主管技师',
      hospital: '浙江大学第一附属医院',
    }),
    '乳腺外科 · 主管技师 · 浙江大学第一附属医院',
  )
  assert.equal(
    formatHealthEducationDoctorMeta({
      id: 'doctor-1',
      name: '渠源',
      avatarUrl: null,
      department: null,
      title: '主管技师',
      hospital: '浙江大学第一附属医院',
    }),
    '主管技师 · 浙江大学第一附属医院',
  )
}

{
  const preview = getHealthEducationCardPreview(item({ content: '# 正文不应该出现在列表预览' }))
  assert.equal(preview.format, '图文')
  assert.equal(preview.previewText, '预览描述')
  assert.equal(preview.thumbnailUrl, 'https://example.com/cover.png')
  assert.equal(preview.thumbnailVariant, 'thumbnail')
}

{
  const preview = getHealthEducationCardPreview(item({
    contentFormat: '海报',
    summary: '',
    content: '',
  }))
  assert.equal(preview.previewText, null)
  assert.equal(preview.thumbnailVariant, 'poster')
}

{
  const listItem = item({})
  const detailItem = item({
    id: '5',
    summary: null,
    content: '# body_markdown 正文',
    imageUrls: [],
    coverUrl: null,
    doctor: {
      id: 'doctor-1',
      name: '渠源',
      avatarUrl: null,
      department: '泌尿外科',
      title: '主管技师',
      hospital: '浙江大学第一附属医院',
    },
  })

  const listMerged = mergeHealthEducationItemForList(listItem, detailItem)
  assert.equal(listMerged.summary, ' 预览描述 ')
  assert.deepEqual(listMerged.imageUrls, ['https://example.com/cover.png'])
  assert.equal(listMerged.coverUrl, 'https://example.com/cover.png')
  assert.equal(listMerged.content, '# body_markdown 正文')
  assert.equal(listMerged.doctor.department, null)
  assert.equal(listMerged.doctor.title, '主管技师')
  assert.equal(listMerged.doctor.hospital, '浙江大学第一附属医院')

  const detailMerged = mergeHealthEducationItemForDetail(listItem, detailItem)
  assert.equal(detailMerged.summary, ' 预览描述 ')
  assert.deepEqual(detailMerged.imageUrls, [])
  assert.equal(detailMerged.coverUrl, null)
  assert.equal(detailMerged.content, '# body_markdown 正文')
}

{
  const detail = item({
    title: '乳腺癌内分泌治疗依从性管理(图文版)',
    content: '# 乳腺癌内分泌治疗依从性管理(图文版)\n\n> 正文摘要\n\n## 一、为什么要坚持 5 年?',
  })
  assert.equal(
    getHealthEducationDetailMarkdown(detail),
    '> 正文摘要\n\n## 一、为什么要坚持 5 年?',
  )
}

{
  const detail = item({
    title: '乳腺癌内分泌治疗依从性管理(图文版)',
    content: '# 另一个标题\n\n正文',
  })
  assert.equal(getHealthEducationDetailMarkdown(detail), '# 另一个标题\n\n正文')
}

console.log('health education presentation tests passed')
