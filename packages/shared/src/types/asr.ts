// Client → Server (browser → backend WebSocket)
export type ClientASRMessage =
  | { type: 'audio_append'; audio: string }
  | { type: 'session_finish' }

// Server → Client (backend WebSocket → browser)
export type ServerASRMessage =
  | { type: 'ready' }
  | { type: 'transcript_partial'; text: string }
  | { type: 'transcript_final'; text: string }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string }
