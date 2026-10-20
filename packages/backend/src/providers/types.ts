/**
 * 语音服务 Provider 抽象层
 *
 * 屏蔽「阿里云 DashScope」和「火山引擎豆包语音」两家厂商的协议差异，对上层路由
 * 只暴露一套 TTS/ASR 会话 API。当前 TTS 仅火山有实现；ASR 两家都要支持，通过
 * env.ASR_PROVIDER 切换。
 *
 * 设计原则（参考 src/api/types.ts）：
 * - Session 封装一次完整对话，由 provider.openSession() 打开；
 * - 上行推送（文本 / PCM 音频）是同步方法，无返回；
 * - 下行事件（音频片段 / 识别结果 / 错误）通过回调触发；
 * - close() 幂等。
 */

/** ---------- TTS ---------- */

export interface TTSSessionOptions {
  /** 音色，仅火山使用（例如 zh_female_shuangkuaisisi_moon_bigtts） */
  voice?: string
  /** 采样率，默认 24000 */
  sampleRate?: number
  /** 仅用于日志追踪 */
  requestId?: string
}

export interface TTSSession {
  /** 追加一段 LLM 流式文本，底层立即转发给上游 */
  sendText(delta: string): void
  /** 文本输入结束，等待上游把剩余音频吐完 */
  finish(): void
  /** 主动中断（用户按下停止 / 客户端断开） */
  cancel(): Promise<void>

  /** 底层收到一段 MP3 音频片段 */
  onAudio(cb: (chunk: Buffer) => void): void
  /** 本次合成完成（正常结束） */
  onEnd(cb: () => void): void
  /** 任何阶段的错误（握手失败 / 协议错误 / 上游 error 帧） */
  onError(cb: (err: Error) => void): void
}

export interface TTSProvider {
  readonly name: 'volcengine' | 'aliyun'
  openSession(opts: TTSSessionOptions): Promise<TTSSession>
}

/** ---------- ASR ---------- */

export interface ASRSessionOptions {
  /** PCM 采样率，默认 16000 */
  sampleRate?: number
  /** 语言，默认 zh */
  language?: string
  /** 仅用于日志 */
  requestId?: string
}

export interface ASRSession {
  /** 推送一段 PCM 音频（base64 编码，遵循现有前端协议） */
  appendAudio(base64Pcm: string): void
  /** 客户端结束录音，通知上游收尾 */
  finish(): void
  /** 主动中断 */
  cancel(): Promise<void>

  /** 中间识别结果（可能带未确认 stash） */
  onPartial(cb: (text: string) => void): void
  /** 确认过的终态片段 */
  onFinal(cb: (text: string) => void): void
  /** Session 完成（上游通知或本地超时） */
  onDone(cb: (fullText: string) => void): void
  /** 出错 */
  onError(cb: (err: Error) => void): void
  /** Session ready（可以开始推音频） */
  onReady(cb: () => void): void
}

export interface ASRProvider {
  readonly name: 'volcengine' | 'aliyun'
  openSession(opts: ASRSessionOptions): Promise<ASRSession>
}
