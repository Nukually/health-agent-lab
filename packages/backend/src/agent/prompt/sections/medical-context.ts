/**
 * 个人信息 + 关注情况 + 病历档案 + 已上传病历文档索引 — 动态 section
 *
 * 拆分原则：
 * - 个人信息、当前关注情况、病历档案、病历文档索引各自独立，便于 LLM 判断上下文边界。
 * - 病历档案仅展示当前 concern/gender 允许暴露的字段，避免模型误更新隐藏字段。
 * - 病历文档索引使用短 ID [d-1]/[d-2]，降低 LLM token 生成开销；assembler 负责把短 ID 映射回 UUID。
 */
import {
  CURRENT_CONCERN_LABELS,
  FIELD_LABELS,
  MENSTRUAL_STATUS_LABELS,
  NODULE_BIRADS_GRADE_LABELS,
  TUMOR_TYPE_LABELS,
  DIAGNOSIS_DURATION_LABELS,
  TREATMENT_PHASE_LABELS,
  MEDICAL_RECORD_FIELDS,
  formatMedicationDurationDetails,
  formatMedicationNames,
  normalizeMedicalProfileData,
  resolveVisibleMedicalFields,
} from '@health-agent/shared'
import type { MedicalProfileData, MedicalDocument, CurrentConcern } from '@health-agent/shared'

interface UserInfo {
  nickname?: string | null
  birthday?: string | null
  gender?: string | null
  currentConcern?: CurrentConcern | null
}

const DOC_TYPE_LABELS: Record<string, string> = {
  outpatient: '门诊',
  pathology: '病理',
  imaging: '影像',
  discharge: '出院',
  lab: '检验',
  other: '其他',
}

const EMPTY = '未填写'

// Asia/Shanghai 日期格式化（YYYY-MM-DD）—— 用于 prompt 里"(YYYY-MM-DD 填写)"后缀
const FILL_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function formatFillDate(iso: string | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  return FILL_DATE_FMT.format(d)
}

function withFillDate(label: string, iso: string | undefined): string {
  const date = formatFillDate(iso)
  return date ? `${label}（${date} 填写）` : label
}

function calcAge(birthday: string): number | null {
  const birth = new Date(birthday)
  if (isNaN(birth.getTime())) return null
  const today = new Date()
  let age = today.getFullYear() - birth.getFullYear()
  const monthDiff = today.getMonth() - birth.getMonth()
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age--
  }
  return age
}

/** 个人信息 section — 昵称 / 生日 / 性别 全量展示，空值显示"未填写" */
export function personalInfoContext(user: UserInfo | null): string {
  const nickname = user?.nickname || EMPTY

  let birthday = EMPTY
  if (user?.birthday) {
    const age = calcAge(user.birthday)
    birthday = age != null ? `${user.birthday}（${age}岁）` : user.birthday
  }

  const gender = user?.gender || EMPTY

  return [
    '## 个人信息',
    `- 昵称：${nickname}`,
    `- 生日：${birthday}`,
    `- 性别：${gender}`,
  ].join('\n')
}

export function currentConcernContext(user: UserInfo | null): string {
  const concern = user?.currentConcern
    ? CURRENT_CONCERN_LABELS[user.currentConcern] || user.currentConcern
    : EMPTY
  const isBreastTumorCare = user?.currentConcern === 'breast_tumor_care'
  const identityBoundary = isBreastTumorCare
    ? '- 身份边界：当前关注情况为乳腺肿瘤相关诊疗；只有在本轮问题明确相关时，才结合乳腺癌/抗肿瘤治疗背景。'
    : '- 身份边界：当前关注情况不是乳腺肿瘤相关诊疗，不要预设用户是乳腺癌患者；乳腺结节、等待结果、不确定或其他乳腺问题都不能自动等同于乳腺癌。'

  return [
    '## 用户长期健康背景 / 当前关注情况',
    `- 当前关注情况：${concern}`,
    '- 只有当前关注情况为乳腺肿瘤相关诊疗时，才可把用户视为乳腺癌/乳腺肿瘤诊疗用户。',
    identityBoundary,
    '- 这只是长期背景，不是本轮问题分类。只有当用户本轮问题和乳腺肿瘤/结节/等待检查结果/乳腺症状/治疗/报告相关时，才结合它判断；普通防晒、饮食、运动、睡眠等泛健康问题按问题本身回答，不要自动转成乳腺癌或结节诊疗建议。',
  ].join('\n')
}

export function medicalFieldPolicyContext(user: UserInfo | null): string {
  const visible = resolveVisibleMedicalFields(user?.currentConcern, user?.gender)
  const hidden = MEDICAL_RECORD_FIELDS.filter((field) => !visible.includes(field))

  const lines = [
    '## 当前病历字段范围',
    `- 当前展示/允许更新的病历字段：${visible.map((field) => FIELD_LABELS[field]).join('、')}`,
  ]

  if (hidden.length) {
    lines.push(`- 当前不展示/不更新的病历字段：${hidden.map((field) => FIELD_LABELS[field]).join('、')}`)
    lines.push('- 对这些未展示字段，不要追问、不要推断、不要调用 update_structured_profile 更新。')
  }

  return lines.join('\n')
}

/**
 * 病历档案 section — 仅展示当前 concern/gender 允许的字段，空值显示"未填写"
 * @param profileData 病历 jsonb
 * @param fallbackFillDate 旧记录无 fieldUpdatedAt 时的兜底（通常传 medical_records.updatedAt）
 */
export function medicalRecordContext(
  user: UserInfo | null,
  profileData: MedicalProfileData | null,
  fallbackFillDate?: string | Date | null,
): string {
  const p = normalizeMedicalProfileData(profileData)
  const visibleFields = resolveVisibleMedicalFields(user?.currentConcern, user?.gender)
  const fallbackIso = fallbackFillDate
    ? fallbackFillDate instanceof Date
      ? fallbackFillDate.toISOString()
      : fallbackFillDate
    : undefined
  const medicationDurationText = formatMedicationDurationDetails(p)

  const values: Record<string, string> = {
    menstrualStatus: p.menstrualStatus
      ? MENSTRUAL_STATUS_LABELS[p.menstrualStatus] || p.menstrualStatus
      : EMPTY,
    noduleBiradsGrade: p.noduleBiradsGrade
      ? NODULE_BIRADS_GRADE_LABELS[p.noduleBiradsGrade] || p.noduleBiradsGrade
      : EMPTY,
    tumorType: p.tumorType ? TUMOR_TYPE_LABELS[p.tumorType] || p.tumorType : EMPTY,
    diagnosisDuration: p.diagnosisDuration
      ? withFillDate(
          DIAGNOSIS_DURATION_LABELS[p.diagnosisDuration] || p.diagnosisDuration,
          p.fieldUpdatedAt?.diagnosisDuration ?? fallbackIso,
        )
      : EMPTY,
    treatmentPhase: p.treatmentPhase
      ? TREATMENT_PHASE_LABELS[p.treatmentPhase] || p.treatmentPhase
      : EMPTY,
    medications: (() => {
      return formatMedicationNames(p) || EMPTY
    })(),
    medicationDuration: medicationDurationText === EMPTY
      ? EMPTY
      : withFillDate(
          medicationDurationText,
          p.fieldUpdatedAt?.medicationDuration ?? fallbackIso,
        ),
  }

  return [
    '## 病历档案（仅本轮明确相关时参考）',
    '- 使用边界：只有当本轮问题明确涉及病历字段、乳腺症状、报告/治疗/用药/复查时，才结合病历档案；日常闲聊、普通防晒、饮食、运动、睡眠等泛健康问题不要主动引用或套用档案。',
    user?.currentConcern === 'breast_tumor_care'
      ? '- 身份边界：当前关注情况为乳腺肿瘤相关诊疗，可在相关问题中结合乳腺癌/抗肿瘤治疗背景。'
      : '- 身份边界：当前关注情况不是乳腺肿瘤相关诊疗，不要预设用户是乳腺癌患者，也不要套用化疗/靶向/内分泌治疗/术后等背景，除非用户本轮明确提供。',
    ...visibleFields.map((field) => `- ${FIELD_LABELS[field]}：${values[field] ?? EMPTY}`),
  ].join('\n')
}

export interface MedicalDocsIndexResult {
  /** 注入 prompt 的文本；无文档时为空串 */
  text: string
  /** d-* 短 ID → UUID 映射；executor 用它把 LLM 传入的 d-1/d-2 还原为 UUID */
  docIdMap: Map<string, string>
}

function sortDocs(docs: MedicalDocument[]): MedicalDocument[] {
  return [...docs].sort((a, b) => {
    const da = a.documentDate || ''
    const db = b.documentDate || ''
    if (da !== db) return db.localeCompare(da)
    return (b.createdAt || '').localeCompare(a.createdAt || '')
  })
}

/**
 * 仅构造短 ID → UUID 映射。与 medicalDocsIndex 的排序完全一致，
 * 供 prompt cache 命中时（跳过重新装配）单独获取映射用。
 */
export function buildDocIdMap(docs: MedicalDocument[]): Map<string, string> {
  const map = new Map<string, string>()
  sortDocs(docs).forEach((d, i) => map.set(`d-${i + 1}`, d.id))
  return map
}

/**
 * 旧版病历文档索引 — 用短 ID [d-1]/[d-2] 注入，降低 LLM 输出 UUID 的开销。
 * 新 prompt 只注入 savedContentSummaryContext；这里保留给历史调试/测试和快照兼容。
 * 按 documentDate desc, createdAt desc 稳定排序，保证同一请求内顺序固定。
 */
export function medicalDocsIndex(docs: MedicalDocument[]): MedicalDocsIndexResult {
  if (!docs.length) {
    return { text: '', docIdMap: new Map() }
  }

  const sorted = sortDocs(docs)
  const docIdMap = new Map<string, string>()
  const lines = [
    '## 已上传病历文档',
    `共 ${sorted.length} 份。新会话需要查看原图时调用 saved_content 的 list/read；旧 d-* 编号仅用于历史上下文兼容。`,
    '这是历史/已保存资料索引，不代表本轮必须读取；用户本轮上传图片时，优先解读当前图片。',
  ]

  sorted.forEach((d, i) => {
    const shortId = `d-${i + 1}`
    docIdMap.set(shortId, d.id)
    const parts = [
      d.title || '未命名',
      d.documentDate ? `就诊 ${d.documentDate}` : null,
      d.documentType ? DOC_TYPE_LABELS[d.documentType] || d.documentType : null,
      d.hospital || null,
    ].filter(Boolean)
    lines.push(`- [${shortId}] ${parts.join(' | ')}`)
  })

  return { text: lines.join('\n'), docIdMap }
}
