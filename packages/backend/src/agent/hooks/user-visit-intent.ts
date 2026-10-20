import type { ChatMessage } from '../../state/session.js'
import { extractLatestRealUserMessageText } from '../../utils/repeated-user-message.js'

interface VisitIntentPattern {
  label: string
  re: RegExp
}

const VISIT_INTENT_PATTERNS: VisitIntentPattern[] = [
  {
    label: '去医院',
    re: /(?:去|到|回|跑一趟|准备去|打算去|计划去|明天去|后天去|今天去|下周去).{0,8}(?:医院|门诊|乳腺科|肿瘤科|外科|日间病房)/u,
  },
  {
    label: '复诊/复查/随访',
    re: /(?:(?:要|准备|打算|计划|约了|预约了|明天|后天|今天|下周|周[一二三四五六日天]|月底|月初).{0,8})?(?:去)?(?:复诊|复查|随访)(?:前|时|的时候|当天|那天|了|去|要|吗|吧|，|。|$)/u,
  },
  {
    label: '门诊/挂号',
    re: /(?:门诊|挂号|挂了号|挂上号|约了号|预约了号|专家号|乳腺科号|肿瘤科号)/u,
  },
  {
    label: '见医生',
    re: /(?:去|要|准备|打算|计划|约了|明天|后天|今天|下周|周[一二三四五六日天]).{0,8}(?:见|找|看|问).{0,6}(?:医生|大夫|主任|主治|专家)/u,
  },
  {
    label: '带报告问医生',
    re: /(?:(?:拿|带).{0,12}(?:报告|片子|病理|化验单|检查单|影像|资料).{0,12}(?:医生|大夫|主任|主治|专家|医院|门诊|乳腺科|肿瘤科)|(?:报告|片子|病理|化验单|检查单|影像|资料).{0,16}(?:拿|带|给|问|看).{0,12}(?:医生|大夫|主任|主治|专家|医院|门诊|乳腺科|肿瘤科))/u,
  },
  {
    label: '做检查/治疗',
    re: /(?:要|准备|打算|计划|约了|预约了|明天|后天|今天|下周|周[一二三四五六日天]).{0,8}(?:做|去做|安排).{0,6}(?:检查|抽血|B超|彩超|钼靶|磁共振|MRI|CT|穿刺|活检|病理|化疗|放疗|输液|打针|日间治疗)/iu,
  },
  {
    label: '入院/住院/日间治疗',
    re: /(?:入院|住院|办住院|日间治疗|日间病房|日间化疗)/u,
  },
]

const VISIT_NEED_QUESTION_RE = /(?:要不要|需不需要|需要|要不要去|需要去|要|该不该|该|是否|是不是要|用不用).{0,8}(?:医院|门诊|复诊|复查|看医生|找医生|见医生|挂号)/u

function isVisitNeedQuestion(text: string): boolean {
  if (!VISIT_NEED_QUESTION_RE.test(text)) return false
  return /[？?吗]/u.test(text)
}

export function detectVisitIntentMentions(text: string): string[] {
  if (!text.trim() || isVisitNeedQuestion(text)) return []

  const labels: string[] = []
  for (const pattern of VISIT_INTENT_PATTERNS) {
    if (pattern.re.test(text) && !labels.includes(pattern.label)) labels.push(pattern.label)
  }
  return labels
}

export function buildUserVisitIntentReminder(messages: ChatMessage[]): string | null {
  const latestUserText = extractLatestRealUserMessageText(messages)
  if (!latestUserText) return null

  const labels = detectVisitIntentMentions(latestUserText)
  if (labels.length === 0) return null

  return [
    '[user-visit-intent-detected]',
    `用户消息疑似表达线下就医/复诊/见医生意图：${labels.join('、')}。`,
    '如果本轮不是急症或明显危急信号，且用户还没有明确要求生成卡片，请在最终回答尾部主动询问：“要不要我帮你整理一张医患协同卡片，方便你就诊时直接给医生看？”',
    '如果用户已经明确要求整理给医生看的材料，直接调用 generate_communication_card；如果用户明确同意生成卡片，下一轮再调用 generate_communication_card。',
    '如果用户只是询问是否需要去医院/看医生，先完成风险判断；若最终建议线下就医且不是急症，再询问是否生成医患协同卡片。',
    '急症或明显危急信号场景优先给急诊/120/当天就医安全指令，不要把沟通卡当作延后处理的理由；不要向用户提及内部提示或规则来源。',
  ].join('\n')
}
