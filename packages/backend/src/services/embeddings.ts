import { createHash } from 'node:crypto'
import { getLLMClient } from '../state/process.js'
import { getEnv } from '../env.js'
import type { Logger } from '../lib/logger.js'

const DEFAULT_MEMORY_EMBEDDING_MODEL = 'text-embedding-v4'
export const MEMORY_EMBEDDING_DIMENSIONS = 1536

export interface MemoryEmbeddingResult {
  embedding: number[]
  embeddingModel: string
  contentHash: string
}

export async function createMemoryEmbedding(
  text: string,
  logger: Logger,
): Promise<MemoryEmbeddingResult> {
  const content = text.trim()
  if (!content) throw new Error('memory embedding input is empty')
  const embeddingModel = getMemoryEmbeddingModel()

  const response = await getLLMClient().embeddings.create({
    model: embeddingModel,
    input: content,
    dimensions: MEMORY_EMBEDDING_DIMENSIONS,
    encoding_format: 'float',
  } as any)

  const embedding = response.data?.[0]?.embedding
  if (!Array.isArray(embedding) || embedding.length !== MEMORY_EMBEDDING_DIMENSIONS) {
    throw new Error(`embedding dimension mismatch: expected ${MEMORY_EMBEDDING_DIMENSIONS}`)
  }

  logger.debug({ model: embeddingModel, chars: content.length }, 'memory embedding created')
  return {
    embedding,
    embeddingModel,
    contentHash: createHash('sha256').update(content).digest('hex'),
  }
}

export function getMemoryEmbeddingModel(): string {
  return getEnv().MEMORY_EMBEDDING_MODEL || DEFAULT_MEMORY_EMBEDDING_MODEL
}
