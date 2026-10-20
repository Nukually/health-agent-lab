/**
 * Provider factory —— 按环境变量选择 TTS / ASR 实现。
 *
 * 目前 TTS 只有火山；ASR 两家都有。缺实现时抛明确错误，便于排查。
 */

import { getEnv } from '../env.js'
import type { ASRProvider, TTSProvider } from './types.js'
import { VolcengineTTSProvider } from './tts/volcengine.js'
import { VolcengineASRProvider } from './asr/volcengine.js'
import { AliyunASRProvider } from './asr/aliyun.js'

let ttsSingleton: TTSProvider | null = null
let asrSingleton: ASRProvider | null = null

export function getTTSProvider(): TTSProvider {
  if (ttsSingleton) return ttsSingleton
  const env = getEnv()
  switch (env.TTS_PROVIDER) {
    case 'volcengine':
      assertVolcengineCreds()
      ttsSingleton = new VolcengineTTSProvider()
      return ttsSingleton
    case 'aliyun':
      throw new Error('Aliyun TTS provider not implemented yet')
    default:
      throw new Error(`Unknown TTS_PROVIDER: ${env.TTS_PROVIDER}`)
  }
}

export function getASRProvider(): ASRProvider {
  if (asrSingleton) return asrSingleton
  const env = getEnv()
  switch (env.ASR_PROVIDER) {
    case 'volcengine':
      assertVolcengineCreds()
      asrSingleton = new VolcengineASRProvider()
      return asrSingleton
    case 'aliyun':
      asrSingleton = new AliyunASRProvider()
      return asrSingleton
    default:
      throw new Error(`Unknown ASR_PROVIDER: ${env.ASR_PROVIDER}`)
  }
}

function assertVolcengineCreds(): void {
  const env = getEnv()
  if (!env.VOLCENGINE_APP_ID) {
    throw new Error('Volcengine credentials missing: VOLCENGINE_APP_ID')
  }
  if (!env.VOLCENGINE_API_KEY && !env.VOLCENGINE_ACCESS_TOKEN) {
    throw new Error('Volcengine credentials missing: VOLCENGINE_API_KEY 或 VOLCENGINE_ACCESS_TOKEN（至少配一个）')
  }
}
