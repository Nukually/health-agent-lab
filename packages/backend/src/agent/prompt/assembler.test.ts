import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleSystemPrompt } from './assembler.js'
import type { Logger } from '../../lib/logger.js'
import type { InterventionRuntimeCatalogSnapshot } from '../../services/intervention-material-runtime.js'

const logger = {
  info: () => undefined,
} as unknown as Logger

const interventionCatalog: InterventionRuntimeCatalogSnapshot = {
  targetEnv: 'dev',
  version: 'test',
  groups: [
    {
      sideEffect: '恶心',
      items: [
        {
          code: '1-1',
          materialId: 'material-1',
          version: 'v1',
          sideEffect: '恶心',
          scene: '呕吐后',
          actionName: '漱口+坐位恢复',
        },
      ],
    },
  ],
  codeMap: new Map(),
}

const otherInterventionCatalog: InterventionRuntimeCatalogSnapshot = {
  targetEnv: 'dev',
  version: 'other',
  groups: [
    {
      sideEffect: '潮热',
      items: [
        {
          code: '1-1',
          materialId: 'material-2',
          version: 'v1',
          sideEffect: '潮热',
          scene: '热醒后烦躁',
          actionName: '小口凉温水节奏饮',
        },
      ],
    },
  ],
  codeMap: new Map(),
}

function buildPrompt(nickname: string) {
  return assembleSystemPrompt({
    userInfo: {
      nickname,
      gender: '女',
      birthday: null,
      currentConcern: 'breast_nodule_followup',
    },
    profileData: null,
    medicalDocs: [],
    interventionCatalog,
    profileMemory: null,
    todayMemory: null,
    structuredProfileTrend: null,
    summary: null,
    logger,
  })
}

test('system prompt and prompt management prompt exclude per-user dynamic context', () => {
  const promptA = buildPrompt('林晓雨')
  const promptB = buildPrompt('陈助手')

  assert.equal(promptA.prompt, promptB.prompt)
  assert.equal(promptA.promptManagementPrompt, promptB.promptManagementPrompt)
  assert.notEqual(promptA.userProfileSystemPrompt, promptB.userProfileSystemPrompt)
  assert.equal(promptA.dynamicPromptReminder, '')
  assert.doesNotMatch(promptA.prompt, /林晓雨|陈助手/)
  assert.doesNotMatch(promptA.promptManagementPrompt, /林晓雨|陈助手/)
})

test('long-term profile memory and stable health context are exposed as second system prompt', () => {
  const assembled = assembleSystemPrompt({
    userInfo: {
      nickname: '林晓雨',
      gender: '女',
      birthday: null,
      currentConcern: 'breast_tumor_care',
    },
    profileData: null,
    medicalDocs: [],
    interventionCatalog,
    profileMemory: '用户希望被称呼为“小雨”。',
    todayMemory: null,
    structuredProfileTrend: null,
    summary: null,
    logger,
  })

  assert.ok(assembled.userProfileSystemPrompt)
  assert.match(assembled.userProfileSystemPrompt, /USER PROFILE \(who the user is\)/)
  assert.match(assembled.userProfileSystemPrompt, /小雨/)
  assert.match(assembled.userProfileSystemPrompt, /## 个人信息/)
  assert.match(assembled.userProfileSystemPrompt, /昵称：林晓雨/)
  assert.match(assembled.userProfileSystemPrompt, /## 用户长期健康背景 \/ 当前关注情况/)
  assert.match(assembled.userProfileSystemPrompt, /## 当前病历字段范围/)
  assert.match(assembled.userProfileSystemPrompt, /## 病历档案（仅本轮明确相关时参考）/)
  assert.doesNotMatch(assembled.userProfileSystemPrompt, /<user-profile>|<user_md>|<\/user_md>/)
  assert.doesNotMatch(assembled.prompt, /小雨/)
  assert.doesNotMatch(assembled.dynamicPromptReminder, /小雨|<user-profile>|<user_md>/)
})

test('system prompt excludes intervention material catalog text', () => {
  const promptA = buildPrompt('林晓雨')
  const promptB = assembleSystemPrompt({
    userInfo: {
      nickname: '林晓雨',
      gender: '女',
      birthday: null,
      currentConcern: 'breast_nodule_followup',
    },
    profileData: null,
    medicalDocs: [],
    interventionCatalog: otherInterventionCatalog,
    profileMemory: null,
    todayMemory: null,
    structuredProfileTrend: null,
    summary: null,
    logger,
  })

  assert.equal(promptA.prompt, promptB.prompt)
  assert.doesNotMatch(promptA.prompt, /当前可选素材编号|漱口\+坐位恢复|小口凉温水节奏饮/)
  assert.doesNotMatch(promptA.promptManagementPrompt, /当前可选素材编号|漱口\+坐位恢复|小口凉温水节奏饮/)
})

test('dynamic prompt no longer carries saved content, recent sessions, or check-in category summaries', () => {
  const assembled = assembleSystemPrompt({
    userInfo: {
      nickname: '林晓雨',
      gender: '女',
      birthday: null,
      currentConcern: 'breast_nodule_followup',
    },
    profileData: null,
    medicalDocs: [{
      id: 'doc-1',
      userId: 'user-1',
      documentDate: '2026-04-17',
      uploadedAt: '2026-04-17T11:00:00.000Z',
      title: '药品说明书/处方',
      documentType: 'other',
      hospital: '测试医院',
      ocrText: '',
      imageUrls: [],
      rawTextUrl: null,
      pageCount: 1,
      createdAt: '2026-04-17T11:00:00.000Z',
      updatedAt: '2026-04-17T11:00:00.000Z',
    }],
    communicationCards: {
      totalCount: 1,
      cards: [{
        id: 'card-1',
        title: '明日就诊沟通卡',
        updatedAt: '2026-04-18T11:00:00.000Z',
        finalUpdatedBy: 'user',
      }],
    },
    savedInterventionMaterials: {
      totalCount: 1,
      items: [{
        materialCode: '1-1',
        materialId: 'material-1',
        materialVersion: 'v1',
        savedAt: '2026-04-19T11:00:00.000Z',
        followStartedAt: null,
        lastFollowedAt: null,
        followCompletedAt: null,
        totalFollowSec: 0,
        completedStepCount: 0,
        totalStepCount: 3,
      }],
    },
    interventionCatalog,
    profileMemory: null,
    todayMemory: null,
    structuredProfileTrend: null,
    summary: null,
    logger,
  })

  assert.equal(assembled.dynamicPromptReminder, '')
  assert.doesNotMatch(assembled.userProfileSystemPrompt ?? '', /## 已保存内容摘要/)
  assert.doesNotMatch(assembled.userProfileSystemPrompt ?? '', /A 我的跟练卡\/跟练视频/)
  assert.doesNotMatch(assembled.userProfileSystemPrompt ?? '', /saved=no/)
  assert.doesNotMatch(assembled.dynamicPromptReminder, /药品说明书\/处方|明日就诊沟通卡|漱口\+坐位恢复/)
})
