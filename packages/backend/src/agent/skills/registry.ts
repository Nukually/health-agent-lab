import { readFile } from 'node:fs/promises'

export interface AgentSkillMeta {
  index: number
  name: string
  description: string
}

interface AgentSkillRegistryItem extends AgentSkillMeta {
  /** 前端时间线展示用的简短中文名，如「副作用疗程管理」。LLM 不可见，不进 prompt。 */
  displayName: string
  fileUrl: URL
}

const SIDE_EFFECT_COURSE_MANAGEMENT: AgentSkillRegistryItem = {
  index: 1,
  name: 'side-effect-course-management',
  displayName: '副作用疗程管理',
  description: '用户反馈症状或治疗副作用导致不适，可能需要跟练资源、干预疗程或疗程反馈管理时触发。',
  fileUrl: new URL('./side-effect-course-management.md', import.meta.url),
}

const AGENT_SKILLS = [
  SIDE_EFFECT_COURSE_MANAGEMENT,
] as const

/** 解析 skill name → 简短中文展示名，供工具调用 input 下发给前端时间线。 */
export function resolveAgentSkillDisplayName(name: string): string | null {
  const skill = AGENT_SKILLS.find((item) => item.name === name.trim())
  return skill?.displayName ?? null
}

export function listAgentSkillMetas(): readonly AgentSkillMeta[] {
  return AGENT_SKILLS.map((skill) => ({
    index: skill.index,
    name: skill.name,
    description: skill.description,
  }))
}

export async function loadAgentSkill(name: string): Promise<(AgentSkillMeta & { content: string }) | null> {
  const normalized = name.trim()
  const skill = AGENT_SKILLS.find((item) => item.name === normalized)
  if (!skill) return null

  const content = await readFile(skill.fileUrl, 'utf8')
  return {
    index: skill.index,
    name: skill.name,
    description: skill.description,
    content,
  }
}
