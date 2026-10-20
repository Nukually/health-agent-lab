import {
  MEDICATION_LABELS,
  type MedicalProfileData,
  type MedicationOption,
} from '@health-agent/shared'
import type { ChatMessage } from '../../state/session.js'
import { extractLatestRealUserMessageText } from '../../utils/repeated-user-message.js'

interface MedicationLexiconEntry {
  key: string
  displayName: string
  profileValue: MedicationOption
  aliases: string[]
}

interface AliasMatch {
  entry: MedicationLexiconEntry
  alias: string
  index: number
  length: number
}

export interface MedicationMention {
  key: string
  displayName: string
  profileValue: MedicationOption
  alias: string
}

// 乳腺癌用户常见药物中/英/缩写词表。
// 注意：结构化档案目前只有 5 个内分泌药枚举，其余药物命中后只能提示模型走 other 流程。
export const BREAST_CANCER_MEDICATION_LEXICON: MedicationLexiconEntry[] = [
  // 内分泌治疗（结构化档案有一一对应枚举）
  {
    key: 'tamoxifen',
    displayName: '他莫昔芬（tamoxifen/TAM）',
    profileValue: 'tamoxifen',
    aliases: ['他莫昔芬', '他莫西芬', '三苯氧胺', 'tamoxifen', 'tamoxifen citrate', '枸橼酸他莫昔芬', 'TAM', 'Nolvadex', '诺瓦得士', 'Soltamox', 'ICI 46,474'],
  },
  {
    key: 'toremifene',
    displayName: '托瑞米芬（toremifene）',
    profileValue: 'other',
    aliases: ['托瑞米芬', 'toremifene', 'toremifene citrate', '枸橼酸托瑞米芬', 'Fareston', '法乐通'],
  },
  {
    key: 'letrozole',
    displayName: '来曲唑（letrozole）',
    profileValue: 'letrozole',
    aliases: ['来曲唑', 'letrozole', 'Femara', '弗隆', 'CGS 20267'],
  },
  {
    key: 'anastrozole',
    displayName: '阿那曲唑（anastrozole）',
    profileValue: 'anastrozole',
    aliases: ['阿那曲唑', 'anastrozole', 'Arimidex', '瑞宁得', 'ZD1033'],
  },
  {
    key: 'exemestane',
    displayName: '依西美坦（exemestane）',
    profileValue: 'exemestane',
    aliases: ['依西美坦', 'exemestane', 'Aromasin', '阿诺新', 'FCE 24304'],
  },
  {
    key: 'fulvestrant',
    displayName: '氟维司群（fulvestrant）',
    profileValue: 'fulvestrant',
    aliases: ['氟维司群', 'fulvestrant', 'Faslodex', '芙仕得', 'ICI 182,780'],
  },
  {
    key: 'elacestrant',
    displayName: '艾拉司群（elacestrant）',
    profileValue: 'other',
    aliases: ['艾拉司群', 'elacestrant', 'elacestrant dihydrochloride', 'Orserdu', 'RAD1901'],
  },
  {
    key: 'imlunestrant',
    displayName: '伊鲁司群（imlunestrant）',
    profileValue: 'other',
    aliases: ['伊鲁司群', 'imlunestrant', 'Inluriyo', 'LY3484356'],
  },

  // 卵巢功能抑制 / 内分泌联合用药（结构化档案归 other）
  {
    key: 'goserelin',
    displayName: '戈舍瑞林（goserelin/Zoladex）',
    profileValue: 'other',
    aliases: ['戈舍瑞林', 'goserelin', 'goserelin acetate', '醋酸戈舍瑞林', 'Zoladex', '诺雷得'],
  },
  {
    key: 'leuprorelin',
    displayName: '亮丙瑞林（leuprorelin/leuprolide）',
    profileValue: 'other',
    aliases: ['亮丙瑞林', '亮脯瑞林', 'leuprorelin', 'leuprolide', 'leuprorelin acetate', 'leuprolide acetate', '醋酸亮丙瑞林', 'Lupron', 'Eligard', 'Enantone', '抑那通'],
  },
  {
    key: 'triptorelin',
    displayName: '曲普瑞林（triptorelin）',
    profileValue: 'other',
    aliases: ['曲普瑞林', 'triptorelin', 'triptorelin acetate', '醋酸曲普瑞林', 'Diphereline', 'Decapeptyl', '达菲林'],
  },

  // HER2 靶向 / ADC（结构化档案归 other；具体药名保留在 reminder 给模型判断）
  {
    key: 'trastuzumab-deruxtecan',
    displayName: '德曲妥珠单抗（trastuzumab deruxtecan/T-DXd）',
    profileValue: 'other',
    aliases: ['德曲妥珠单抗', 'trastuzumab deruxtecan', 'fam-trastuzumab deruxtecan-nxki', '曲妥珠单抗-德鲁替康偶联物', 'T-DXd', 'T-DXD', 'DS-8201', 'Enhertu', '优赫得'],
  },
  {
    key: 'ado-trastuzumab-emtansine',
    displayName: '恩美曲妥珠单抗（ado-trastuzumab emtansine/T-DM1）',
    profileValue: 'other',
    aliases: ['恩美曲妥珠单抗', 'trastuzumab emtansine', 'ado-trastuzumab emtansine', '曲妥珠单抗-美坦新偶联物', 'T-DM1', 'Kadcyla', '赫赛莱'],
  },
  {
    key: 'trastuzumab',
    displayName: '曲妥珠单抗（trastuzumab）',
    profileValue: 'other',
    aliases: ['曲妥珠单抗', 'trastuzumab', 'Herceptin', '赫赛汀'],
  },
  {
    key: 'pertuzumab',
    displayName: '帕妥珠单抗（pertuzumab）',
    profileValue: 'other',
    aliases: ['帕妥珠单抗', 'pertuzumab', 'Perjeta', '帕捷特'],
  },
  {
    key: 'pyrotinib',
    displayName: '吡咯替尼（pyrotinib）',
    profileValue: 'other',
    aliases: ['吡咯替尼', 'pyrotinib', 'pyrotinib maleate', '马来酸吡咯替尼', 'Irene', 'SHR1258', '艾瑞妮'],
  },
  {
    key: 'lapatinib',
    displayName: '拉帕替尼（lapatinib）',
    profileValue: 'other',
    aliases: ['拉帕替尼', 'lapatinib', 'lapatinib ditosylate', '二甲苯磺酸拉帕替尼', 'Tykerb', 'Tyverb', 'GW572016', '泰立沙'],
  },
  {
    key: 'neratinib',
    displayName: '奈拉替尼（neratinib）',
    profileValue: 'other',
    aliases: ['奈拉替尼', '来那替尼', 'neratinib', 'neratinib maleate', '马来酸奈拉替尼', 'Nerlynx', 'HKI-272', '贺俪安'],
  },
  {
    key: 'tucatinib',
    displayName: '图卡替尼（tucatinib）',
    profileValue: 'other',
    aliases: ['图卡替尼', '妥卡替尼', 'tucatinib', 'Tukysa', 'ONT-380', 'ARRY-380'],
  },
  {
    key: 'sacituzumab-govitecan',
    displayName: '戈沙妥珠单抗（sacituzumab govitecan/SG）',
    profileValue: 'other',
    aliases: ['戈沙妥珠单抗', 'sacituzumab govitecan', 'sacituzumab govitecan-hziy', 'SG', 'Trodelvy', 'IMMU-132', '拓达维'],
  },
  {
    key: 'datopotamab-deruxtecan',
    displayName: '达托泊单抗德鲁替康（datopotamab deruxtecan/Dato-DXd）',
    profileValue: 'other',
    aliases: ['达托泊单抗德鲁替康', '德达博妥单抗', 'datopotamab deruxtecan', 'datopotamab deruxtecan-dlnk', 'Dato-DXd', 'DS-1062', 'DS-1062a', 'Datroway'],
  },
  {
    key: 'phesgo',
    displayName: 'PHESGO固定复方制剂（帕妥珠单抗-曲妥珠单抗-透明质酸酶）',
    profileValue: 'other',
    aliases: ['PHESGO', '飞赫达', '帕妥珠单抗-曲妥珠单抗-透明质酸酶复方制剂', 'pertuzumab, trastuzumab and hyaluronidase-zzxf'],
  },

  // CDK4/6、PI3K/mTOR、PARP 等常见联合治疗药物（结构化档案归 other）
  {
    key: 'palbociclib',
    displayName: '哌柏西利（palbociclib）',
    profileValue: 'other',
    aliases: ['哌柏西利', 'palbociclib', 'Ibrance', 'PD-0332991', '爱博新'],
  },
  {
    key: 'ribociclib',
    displayName: '瑞博西利/瑞波西利（ribociclib）',
    profileValue: 'other',
    aliases: ['瑞博西利', '瑞波西利', 'ribociclib', 'ribociclib succinate', '琥珀酸瑞博西利', 'Kisqali', 'LEE011', '凯丽隆'],
  },
  {
    key: 'abemaciclib',
    displayName: '阿贝西利（abemaciclib）',
    profileValue: 'other',
    aliases: ['阿贝西利', 'abemaciclib', 'Verzenio', 'LY2835219', '唯择'],
  },
  {
    key: 'capivasertib',
    displayName: '卡匹色替（capivasertib）',
    profileValue: 'other',
    aliases: ['卡匹色替', '卡匹色替片', 'capivasertib', 'Truqap', 'AZD5363', '荃科得'],
  },
  {
    key: 'everolimus',
    displayName: '依维莫司（everolimus）',
    profileValue: 'other',
    aliases: ['依维莫司', 'everolimus', 'Afinitor', 'RAD001', '飞尼妥'],
  },
  {
    key: 'alpelisib',
    displayName: '阿培利司（alpelisib）',
    profileValue: 'other',
    aliases: ['阿培利司', 'alpelisib', 'Piqray', 'BYL719', 'NVP-BYL719'],
  },
  {
    key: 'inavolisib',
    displayName: '伊那利塞（inavolisib）',
    profileValue: 'other',
    aliases: ['伊那利塞', 'inavolisib', 'Itovebi', 'GDC-0077', 'RG6114', 'RG 6114', 'RO-7113755', '伊赫莱'],
  },
  {
    key: 'olaparib',
    displayName: '奥拉帕利（olaparib）',
    profileValue: 'other',
    aliases: ['奥拉帕利', 'olaparib', 'Lynparza', 'AZD2281', 'KU-0059436', '利普卓'],
  },
  {
    key: 'talazoparib',
    displayName: '他拉唑帕利（talazoparib）',
    profileValue: 'other',
    aliases: ['他拉唑帕利', 'talazoparib', 'talazoparib tosylate', '甲苯磺酸他拉唑帕利', 'Talzenna', 'BMN 673', '泰泽纳'],
  },
  {
    key: 'denosumab',
    displayName: '地舒单抗（denosumab）',
    profileValue: 'other',
    aliases: ['地舒单抗', 'denosumab', 'Xgeva', 'Prolia', 'AMG 162', '安加维', '普罗力'],
  },
  {
    key: 'zoledronic-acid',
    displayName: '唑来膦酸（zoledronic acid）',
    profileValue: 'other',
    aliases: ['唑来膦酸', 'zoledronic acid', 'zoledronate', 'Zometa', 'Aclasta', 'Reclast', '择泰', '密固达'],
  },

  // 乳腺癌常见化疗药（结构化档案归 other）
  {
    key: 'paclitaxel',
    displayName: '紫杉醇（paclitaxel/PTX）',
    profileValue: 'other',
    aliases: ['紫杉醇', 'paclitaxel', 'PTX', 'Taxol', '泰素'],
  },
  {
    key: 'nab-paclitaxel',
    displayName: '白蛋白结合型紫杉醇（nab-paclitaxel）',
    profileValue: 'other',
    aliases: ['白蛋白结合型紫杉醇', '白蛋白紫杉醇', '白紫', 'nab-paclitaxel', 'albumin-bound paclitaxel', 'nanoparticle albumin-bound paclitaxel', 'Abraxane', '凯素'],
  },
  {
    key: 'docetaxel',
    displayName: '多西他赛（docetaxel/DTX）',
    profileValue: 'other',
    aliases: ['多西他赛', 'docetaxel', 'DTX', 'Taxotere', 'RP 56976', '泰索帝'],
  },
  {
    key: 'capecitabine',
    displayName: '卡培他滨（capecitabine）',
    profileValue: 'other',
    aliases: ['卡培他滨', 'capecitabine', 'Xeloda', '希罗达'],
  },
  {
    key: 'doxorubicin',
    displayName: '多柔比星/阿霉素（doxorubicin）',
    profileValue: 'other',
    aliases: ['多柔比星', '盐酸多柔比星', '阿霉素', 'doxorubicin', 'doxorubicin hydrochloride', 'doxorubicin HCl', 'Adriamycin'],
  },
  {
    key: 'epirubicin',
    displayName: '表柔比星（epirubicin）',
    profileValue: 'other',
    aliases: ['表柔比星', '盐酸表柔比星', 'epirubicin', 'epirubicin hydrochloride', 'Pharmorubicin', 'Farmorubicin', 'Ellence', "4'-Epidoxorubicin", '法玛新'],
  },
  {
    key: 'cyclophosphamide',
    displayName: '环磷酰胺（cyclophosphamide/CTX）',
    profileValue: 'other',
    aliases: ['环磷酰胺', 'cyclophosphamide', 'CTX', 'CPA', 'Cytoxan', 'Endoxan', '安道生'],
  },
  {
    key: 'carboplatin',
    displayName: '卡铂（carboplatin）',
    profileValue: 'other',
    aliases: ['卡铂', 'carboplatin', 'Paraplatin', 'CBDCA', '波贝'],
  },
  {
    key: 'cisplatin',
    displayName: '顺铂（cisplatin）',
    profileValue: 'other',
    aliases: ['顺铂', 'cisplatin', 'Platinol', 'CDDP'],
  },
  {
    key: 'gemcitabine',
    displayName: '吉西他滨（gemcitabine）',
    profileValue: 'other',
    aliases: ['吉西他滨', '盐酸吉西他滨', 'gemcitabine', 'gemcitabine hydrochloride', 'Gemzar', 'dFdC', '健择'],
  },
  {
    key: 'vinorelbine',
    displayName: '长春瑞滨（vinorelbine）',
    profileValue: 'other',
    aliases: ['长春瑞滨', '酒石酸长春瑞滨', 'vinorelbine', 'vinorelbine tartrate', 'Navelbine', 'VNR', '诺维本'],
  },
  {
    key: 'eribulin',
    displayName: '艾日布林/艾立布林（eribulin）',
    profileValue: 'other',
    aliases: ['艾日布林', '艾立布林', '甲磺酸艾日布林', 'eribulin', 'eribulin mesylate', 'Halaven', 'E7389', '海乐卫'],
  },
  {
    key: 'fluorouracil',
    displayName: '氟尿嘧啶（fluorouracil/5-FU）',
    profileValue: 'other',
    aliases: ['氟尿嘧啶', '5-氟尿嘧啶', 'fluorouracil', '5-fluorouracil', '5-FU', 'Adrucil'],
  },
]

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasCjk(s: string): boolean {
  return /[\u3400-\u9fff]/.test(s)
}

// 常见药名 ASR / 手输同音错别字归一匹配表。
// 只用于长度 >= 3 的中文药名别名，避免“弗隆/白紫/卡铂”等短词被过度泛化误命中。
const CJK_HOMOPHONE_GROUPS = [
  ['唑', '挫', '坐', '座', '佐'],
  ['阿', '啊'],
  ['那', '娜'],
  ['依', '伊'],
  ['昔', '西', '希'],
  ['芬', '分', '酚', '汾'],
  ['曲', '屈'],
  ['坦', '谈', '碳'],
  ['妥', '托'],
  ['珠', '朱', '株'],
  ['单', '丹'],
  ['抗', '亢'],
  ['德', '得'],
  ['氟', '弗'],
  ['维', '唯'],
  ['司', '斯'],
  ['群', '裙'],
  ['戈', '哥'],
  ['舍', '社'],
  ['瑞', '睿', '锐'],
  ['林', '淋', '琳', '霖', '麟'],
  ['亮', '量'],
  ['丙', '炳'],
  ['脯', '普', '谱'],
  ['吡', '匹'],
  ['咯', '罗', '洛'],
  ['替', '提'],
  ['尼', '妮'],
  ['哌', '派'],
  ['柏', '博', '伯'],
  ['波', '泊', '博'],
  ['利', '力', '里'],
  ['贝', '倍'],
  ['美', '梅', '莓'],
  ['莫', '膜'],
  ['培', '陪', '配'],
  ['奥', '澳'],
  ['拉', '啦'],
  ['帕', '怕'],
  ['杉', '衫'],
  ['醇', '淳'],
  ['他', '她', '它'],
  ['赛', '塞'],
  ['滨', '宾', '斌', '彬'],
  ['柔', '揉'],
  ['星', '新'],
  ['胺', '安', '氨'],
  ['白', '百'],
  ['立', '力'],
  ['来', '莱'],
  ['艾', '爱'],
  ['米', '迷', '咪'],
  ['鲁', '卢', '璐'],
  ['色', '瑟'],
  ['卡', '咔'],
  ['康', '慷'],
  ['达', '大'],
  ['舒', '书'],
  ['膦', '磷', '鳞'],
] as const

const CJK_HOMOPHONE_CHARS = new Map<string, string>()
for (const group of CJK_HOMOPHONE_GROUPS) {
  const charClass = `[${[...new Set(group)].map(escapeRegExp).join('')}]`
  for (const char of group) CJK_HOMOPHONE_CHARS.set(char, charClass)
}

function findLooseCjkAliasMatch(text: string, alias: string): { index: number; length: number } | null {
  if (Array.from(alias).length < 3) return null

  const pattern = Array.from(alias)
    .map((char) => CJK_HOMOPHONE_CHARS.get(char) ?? escapeRegExp(char))
    .join('')
  const match = new RegExp(pattern, 'u').exec(text)
  return match ? { index: match.index, length: match[0].length } : null
}

function findAliasMatch(text: string, alias: string): { index: number; length: number } | null {
  if (hasCjk(alias)) {
    const exactIndex = text.indexOf(alias)
    const exactMatch = exactIndex >= 0 ? { index: exactIndex, length: alias.length } : null
    const looseMatch = findLooseCjkAliasMatch(text, alias)
    if (!exactMatch) return looseMatch
    if (!looseMatch) return exactMatch
    return exactMatch.index <= looseMatch.index ? exactMatch : looseMatch
  }

  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegExp(alias)})(?=$|[^\\p{L}\\p{N}])`, 'iu')
  const match = re.exec(text)
  if (!match) return null

  return {
    index: match.index + (match[1]?.length ?? 0),
    length: match[2].length,
  }
}

function overlaps(a: { index: number; length: number }, b: { index: number; length: number }): boolean {
  return a.index < b.index + b.length && b.index < a.index + a.length
}

export function detectBreastCancerMedicationMentions(text: string): MedicationMention[] {
  const candidates: AliasMatch[] = []
  for (const entry of BREAST_CANCER_MEDICATION_LEXICON) {
    for (const alias of entry.aliases) {
      const span = findAliasMatch(text, alias)
      if (span) candidates.push({ entry, alias, ...span })
    }
  }

  candidates.sort((a, b) => b.length - a.length || a.index - b.index)

  const selected: AliasMatch[] = []
  const seenKeys = new Set<string>()
  for (const candidate of candidates) {
    if (seenKeys.has(candidate.entry.key)) continue
    if (selected.some((m) => overlaps(candidate, m))) continue
    selected.push(candidate)
    seenKeys.add(candidate.entry.key)
  }

  return selected
    .sort((a, b) => a.index - b.index)
    .map((m) => ({
      key: m.entry.key,
      displayName: m.entry.displayName,
      profileValue: m.entry.profileValue,
      alias: m.alias,
    }))
}

function splitCustomMedicationNames(raw: string | null | undefined): string[] {
  if (!raw) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const part of raw.split(/[、,，;；/]+/g)) {
    const name = part.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    result.push(name)
  }
  return result
}

function detectProfileCustomMedicationMentions(
  text: string,
  profileData: MedicalProfileData | null | undefined,
): MedicationMention[] {
  if (!Array.isArray(profileData?.medications) || !profileData.medications.includes('other')) {
    return []
  }

  return splitCustomMedicationNames(profileData.medicationCustom)
    .filter((name) => name.length > 0 && text.includes(name))
    .map((name) => ({
      key: `custom:${name}`,
      displayName: name,
      profileValue: 'other' as const,
      alias: name,
    }))
}

function mergeMedicationMentions(mentions: MedicationMention[]): MedicationMention[] {
  const seen = new Set<string>()
  const result: MedicationMention[] = []
  for (const mention of mentions) {
    if (seen.has(mention.key)) continue
    seen.add(mention.key)
    result.push(mention)
  }
  return result
}

function profileMedicationLabel(profileData: MedicalProfileData | null | undefined): string {
  const medications = profileData?.medications
  if (!Array.isArray(medications) || medications.length === 0) return '未填写'

  const labels = medications.map((m) => MEDICATION_LABELS[m] || m)
  const custom = typeof profileData?.medicationCustom === 'string'
    ? profileData.medicationCustom.trim()
    : ''
  if (custom && medications.includes('other')) {
    const otherIdx = labels.indexOf(MEDICATION_LABELS.other)
    if (otherIdx >= 0) labels[otherIdx] = custom
  }
  return labels.join('、')
}

function formatMedicationMention(mention: MedicationMention): string {
  return mention.alias === mention.displayName
    ? mention.displayName
    : `${mention.displayName}（命中别名：${mention.alias}）`
}

export function buildUserPromptMedicationReminder(
  messages: ChatMessage[],
  profileData: MedicalProfileData | null | undefined,
): string | null {
  const latestUserText = extractLatestRealUserMessageText(messages)
  if (!latestUserText) return null

  const mentions = mergeMedicationMentions([
    ...detectBreastCancerMedicationMentions(latestUserText),
    ...detectProfileCustomMedicationMentions(latestUserText, profileData),
  ])
  if (mentions.length === 0) return null

  const mentionedDrugs = mentions.map(formatMedicationMention).join('、')

  return [
    '[user-prompt-medication-detected]',
    `用户疑似提到了：${mentionedDrugs}。`,
    `个人档案药物：${profileMedicationLabel(profileData)}。`,
    '药物别名命中只用于名称识别；不能据此判断剂量、疗程、是否可替换使用、是否自行停换加减药。',
    '如果本轮涉及处方药停药、换药、加减量、同服或副作用，属于医学问题；最终回答前必须先原生调用 grade_medical_risk。',
  ].filter(Boolean).join('\n')
}
