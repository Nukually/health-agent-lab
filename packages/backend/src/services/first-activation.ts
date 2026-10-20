import { and, eq, like } from 'drizzle-orm'
import {
  BREAST_CANCER_EXTENSION_FIELDS,
  CURRENT_CONCERN_LABELS,
  FIELD_LABELS,
  FIRST_ACTIVATION_WELCOME_MESSAGE,
  resolveVisibleMedicalFields,
  type CurrentConcern,
  type MedicalProfileData,
} from '@health-agent/shared'
import { getDb } from '../db/client.js'
import { messages } from '../db/schema/index.js'
import type { ChatMessage } from '../state/session.js'

const FIRST_ACTIVATION_REMINDER_MARKER = '[first-activation-guide]'
const FIRST_ACTIVATION_ASSISTANT_CONTEXT_MESSAGE = FIRST_ACTIVATION_WELCOME_MESSAGE

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content

  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type: string; text: string } =>
          !!part &&
          typeof part === 'object' &&
          'type' in part &&
          (part as { type?: unknown }).type === 'text' &&
          typeof (part as { text?: unknown }).text === 'string',
      )
      .map((part) => part.text)
      .join('\n')
  }

  return ''
}

function isMissingField(field: string, profileData: MedicalProfileData | null | undefined): boolean {
  const value = profileData?.[field as keyof MedicalProfileData]
  if (Array.isArray(value)) return value.length === 0
  return value == null || value === ''
}

function resolveFirstActivationTargetFields(params: {
  currentConcern: CurrentConcern | null | undefined
  gender?: string | null
  profileData?: MedicalProfileData | null
}): string[] {
  const { currentConcern, gender, profileData } = params
  const visible = resolveVisibleMedicalFields(currentConcern, gender)

  const ordered = currentConcern === 'breast_tumor_care'
    ? [
        ...BREAST_CANCER_EXTENSION_FIELDS,
        ...visible.filter((field) => !BREAST_CANCER_EXTENSION_FIELDS.includes(field as any)),
      ]
    : visible

  return ordered.filter((field) => {
    if (field === 'medicationDuration') {
      const meds = profileData?.medications ?? []
      if (meds.includes('none') || meds.length === 0) {
        return false
      }
    }
    return isMissingField(field, profileData)
  })
}

export function buildFirstActivationAssistantMessage(): ChatMessage {
  return {
    role: 'assistant',
    content: FIRST_ACTIVATION_ASSISTANT_CONTEXT_MESSAGE,
  }
}

export function buildFirstActivationSceneReminder(params: {
  currentConcern: CurrentConcern | null | undefined
  gender?: string | null
  profileData?: MedicalProfileData | null
}): string {
  const concernLabel = params.currentConcern
    ? CURRENT_CONCERN_LABELS[params.currentConcern]
    : '未设置'
  const targetFields = resolveFirstActivationTargetFields(params)
  const hiddenCancerFields = params.currentConcern === 'breast_tumor_care'
    ? []
    : BREAST_CANCER_EXTENSION_FIELDS.map((field) => FIELD_LABELS[field])

  return `${FIRST_ACTIVATION_REMINDER_MARKER}
当前场景：上一条 assistant 消息是系统自动展示给用户的首次欢迎语，不需要你重复复述欢迎语本身。
这是用户首次登录后的健康档案收集场景，你的核心任务是通过自然对话和用户上传的截图，帮助其逐步完善档案。

- 当前关注情况：${concernLabel}。
- 当前优先补充字段：${targetFields.length > 0 ? targetFields.map((field) => FIELD_LABELS[field as keyof typeof FIELD_LABELS] || field).join('、') : '暂无必须补充的字段，优先围绕用户当前问题继续交流'}。
- 如果用户本轮消息或上传图片里已经包含上述字段信息，必须立刻调用 update_structured_profile 更新对应字段。
- 只追问当前最关键的 1-2 个缺口字段，不要把用户推回表单填写。
- 如果用户上传检查报告、病历、出院记录、体检报告或用药单图片，先提取关键信息，再据此完善档案并继续回答。
${hiddenCancerFields.length > 0 ? `- 当前不要追问、不要推断、也不要更新这些乳腺癌扩展字段：${hiddenCancerFields.join('、')}。` : '- 乳腺癌扩展字段（肿瘤分型 / 确诊时长 / 治疗阶段）是当前场景的重要信息，若用户明确提到应优先补齐。'}
- 接下来这一轮对话的核心目标是把用户刚提供的信息落到档案里，除非用户主动拒绝或切到完全不同的话题。`
}

export function hasFirstActivationReminder(content: unknown): boolean {
  return extractTextContent(content).includes(FIRST_ACTIVATION_REMINDER_MARKER)
}

export function isFirstActivationConversation(
  messages: Array<{ role: string; content: unknown }>,
): boolean {
  return messages.some((message) => message.role === 'user' && hasFirstActivationReminder(message.content))
}

export async function isFirstActivationConversationSession(sessionId: string): Promise<boolean> {
  const db = getDb()
  const match = await db.query.messages.findFirst({
    where: and(
      eq(messages.sessionId, sessionId),
      eq(messages.role, 'user'),
      like(messages.content, `%${FIRST_ACTIVATION_REMINDER_MARKER}%`),
    ),
    columns: { id: true },
  })

  return !!match
}

export function buildHealthProfileAuthorizationRejectedReminder(fields: string[]): string {
  const labels = [...new Set(fields)]
    .map((field) => FIELD_LABELS[field as keyof typeof FIELD_LABELS] || field)
    .join('、')

  return `系统提示：用户刚刚拒绝了健康档案二次授权，因此你上一轮尝试更新健康档案的操作失败了。${labels ? `失败字段：${labels}。` : ''}

这次失败的原因是“未获授权”，不是用户拒绝这些字段本身；不要把它写成 profile_rejected，也不要假设这些字段以后都不能更新。

如果用户下次再次通过聊天或上传截图提供相关信息，你仍然可以继续正常回应；但在当前轮次里，不要说“确认卡片已发送”或暗示档案已经更新成功。`
}
