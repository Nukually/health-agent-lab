export type ChannelSourceType = 'online' | null

export interface UserChannelSourceInfo {
  type: ChannelSourceType
  channelPartnerName: string | null
}

const ONLINE_CHANNEL_PARTNER_NAMES = new Set(['线上'])

export function resolveChannelSourceTypeFromPartnerName(name: string | null | undefined): ChannelSourceType {
  const normalized = typeof name === 'string' ? name.trim() : ''
  return ONLINE_CHANNEL_PARTNER_NAMES.has(normalized) ? 'online' : null
}
