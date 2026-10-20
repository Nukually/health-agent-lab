import { TOOL_UI_MANIFEST } from '@health-agent/shared'
import type { ToolDefinition } from '../../api/types.js'

export const GRADE_MEDICAL_RISK_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'grade_medical_risk',
    description: [
      '对当前医学问题做风险分级和场景分类，并返回对应处置策略或症状/副作用疗程 skill，供最终回答使用。',
      '所有医学问题都必须在最终回答前调用一次本工具；非医学问题不要调用。',
      '分级只用于本轮回答的处置强度，不是诊断结论，也不能作为调整用药方案的依据。',
      '信息不足时，按最可能造成安全后果的档位保守分级。',
      '不要把“需要主管医生确认”“不能自行停换药”本身等同于紧急；先判断是否有急症、危急安全或短时间内不可逆风险。'
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: '一句话简要说明分级依据；先写原因，再写等级；避免展开完整处置方案；最长 120 个字符。',
        },
        level: {
          type: 'string',
          enum: ['S', 'A', 'B0', 'B1', 'C'],
          description: [
            '风险等级。',
            'S=危急：已经或高度怀疑危及生命，或患者无法安全自行前往医院/无法保证自身安全；需要用户或身边人立即拨 120/当地急救或危机干预。',
            'A=紧急：需要立即门急诊/精神心理急诊/危机干预，或短时间内不处理会带来明确安全风险；患者意识清楚、生命体征相对稳定且可自行或由家属陪同前往，若不能自行或安全不可保证则升 S。',
            'B0=要紧：疑似恶性、高危报告、疑似复发转移、需尽快就医的副作用/并发症，或虽不满足 S/A 但不适合 AI 观察等待；走快速线下专科或主管医生确认，只有出现急症红旗时才走门急诊。',
            'B1=门诊评估：需要近期复诊、线下体检、影像、复查、主管医生或药师确认，但暂无 S/A/B0；如疲乏复诊、地舒单抗是否继续等无急症信号的治疗确认。',
            // TODO: 线上医生渠道上线后，再新增远程医生解释/复核分级。
            'C=低风险：低风险科普、资料整理、随访提醒、稳定轻微症状记录。',
          ].join('\n'),
        },
        category: {
          type: 'string',
          enum: [
            'general_knowledge',
            'current_symptom',
            'side_effect',
            'medication_treatment',
            'report_interpretation',
            'followup_rehab',
            'mental_crisis',
            'other_medical',
          ],
          description: [
            '医学问题场景分类；按本轮医学问题的主要场景选择一个，不要为了覆盖多个话题传多个分类。',
            '不要为了后续生成干预资源改错分类；只有治疗或药物相关副作用才选 side_effect。',
            'general_knowledge=医学知识科普、稳定风险解释、一般治疗概念说明。',
            'current_symptom=当前正在发生的症状、不适、急症信号或分诊判断；B0/B1/C 会返回症状疗程 skill 调度。',
            'side_effect=治疗或药物相关副作用、护理和居家干预边界。',
            'medication_treatment=漏服、同服、停药、换药、加减量、疗程、是否接受或放弃治疗等用药/治疗决策；先阻止用户自行调整，再判断是否有急症信号；无急症信号时通常走 B1 近期复诊/联系主管医生或药师确认，不要直接判 A。',
            'report_interpretation=病理、免疫组化、基因检测、影像、检验、处方、用药单、说明书等报告/资料解读。',
            'followup_rehab=复查随访、营养、运动、康复、术后恢复、长期管理。',
            'mental_crisis=自伤、自杀、极端绝望、明确说“活着没意思/不想活”等精神危机；先给安全兜底再追问，不能只追问；有计划、工具、独处、失控或无法保证安全时用 S，否则至少用 A。',
            'other_medical=确属医学问题但不属于以上分类，或明显需要其他专科判断。',
          ].join('\n'),
        },
      },
      required: ['reason', 'level', 'category'],
    },
  },
  uiMeta: TOOL_UI_MANIFEST.grade_medical_risk,
  isReadOnly: true,
  maxResultSizeChars: 4_000,
}
