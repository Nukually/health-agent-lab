import assert from 'node:assert/strict'
import test from 'node:test'
import { mapDxItem } from './health-education.js'

const emptyStats = {
  itemId: '6',
  likeCount: 0,
  dislikeCount: 0,
  favoriteCount: 0,
  pvCount: 0,
  uvCount: 0,
  userReaction: null,
  isFavorited: false,
} as const

test('mapDxItem reads DX v2 detail body_markdown as content', () => {
  const item = mapDxItem({
    poster_id: 6,
    title: '乳腺癌术后骨健康管理手册',
    drug: '阿那曲唑',
    content_format: '手册',
    body_markdown: '# 骨健康管理\n\n请按医嘱复诊。',
    published_at: '2026-05-22T14:07:16.440584+08:00',
    doctor: {
      doctor_id: 'doctor-1',
      name: '渠源',
      title: '主管技师',
      hospital: '浙江大学第一附属医院',
      department: '乳腺外科',
      avatar_url: null,
    },
  }, 'https://doctor.example.test', emptyStats)

  assert.equal(item.id, '6')
  assert.equal(item.contentFormat, '手册')
  assert.equal(item.content, '# 骨健康管理\n\n请按医嘱复诊。')
  assert.equal(item.summary, null)
  assert.equal(item.doctor.id, 'doctor-1')
})

test('mapDxItem keeps list preview and cover image from DX v2 list item', () => {
  const item = mapDxItem({
    poster_id: 5,
    title: '乳腺癌内分泌治疗依从性管理(图文版)',
    drug: '他莫昔芬',
    content_format: '图文',
    cover_image_url: '/media/covers/5.png',
    preview_text: '依从性管理摘要',
    published_at: '2026-05-22T14:07:16.440584+08:00',
    doctor: {
      name: '渠源',
      title: '主管技师',
      hospital: '浙江大学第一附属医院',
      avatar_url: '/avatars/doctor.png',
    },
  }, 'https://doctor.example.test', { ...emptyStats, itemId: '5' })

  assert.equal(item.content, '依从性管理摘要')
  assert.equal(item.summary, '依从性管理摘要')
  assert.deepEqual(item.imageUrls, ['https://doctor.example.test/media/covers/5.png'])
  assert.equal(item.coverUrl, 'https://doctor.example.test/media/covers/5.png')
  assert.equal(item.doctor.avatarUrl, '/avatars/doctor.png')
})
