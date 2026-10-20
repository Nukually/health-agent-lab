// Client → Server (browser → backend WebSocket)
export type ClientTTSMessage =
  | { type: 'text_delta'; text: string }
  | { type: 'text_end' }
  | { type: 'cancel' }

// Server → Client (backend WebSocket → browser)
// audio 帧为二进制（BinaryType = 'arraybuffer'），下列为 JSON 控制帧
export type ServerTTSMessage =
  | { type: 'audio_start'; format: 'mp3'; sampleRate: number }
  | { type: 'audio_end' }
  | { type: 'error'; message: string }
