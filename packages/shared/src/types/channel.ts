export type ChannelStatus = 'active' | 'inactive'

export interface ChannelPartner {
  id: string
  code: string
  name: string
  status: ChannelStatus
  createdAt: string
  updatedAt: string
}

export interface ChannelAgent {
  id: string
  partnerId: string
  code: string
  name: string
  status: ChannelStatus
  createdAt: string
  updatedAt: string
}

export interface ChannelQrCode {
  id: string
  partnerId: string
  agentId: string
  code: string
  url: string
  status: ChannelStatus
  createdAt: string
  updatedAt: string
}

export interface ChannelQrCodeExportRow {
  partnerCode: string
  partnerName: string
  agentCode: string
  agentName: string
  qrCode: string
  url: string
}

export interface ChannelPartnerSaveRequest {
  code: string
  name: string
  status?: ChannelStatus
}

export interface ChannelAgentSaveRequest {
  code: string
  name: string
  status?: ChannelStatus
}

export interface ChannelQrCodeBulkCreateRequest {
  partnerId: string
  agentId: string
  count: number
}

export interface ChannelPartnerResponse {
  partner: ChannelPartner
}

export interface ChannelAgentResponse {
  agent: ChannelAgent
}

export interface ChannelQrCodeBulkCreateResponse {
  items: ChannelQrCode[]
}
