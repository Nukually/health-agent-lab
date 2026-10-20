import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import type { InternalVideoTags } from '@health-agent/shared'
import { users } from './users.js'
import { chatSessions } from './sessions.js'

/**
 * 内部高质量跟练视频 catalog 的 DB 镜像。
 * 源真相是各环境 OSS 的 internal-videos/catalog/index.json（由 scripts/sync-internal-videos.mjs 写入）；
 * 后端 internal-video-runtime 读 OSS catalog 后 upsert 到这里，作为可查询/可匹配的镜像。
 */
export const internalVideos = pgTable(
  'internal_videos',
  {
    videoId: varchar('video_id', { length: 120 }).primaryKey(),
    version: varchar('version', { length: 120 }).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    description: text('description').notNull().default(''),
    sourceRef: varchar('source_ref', { length: 500 }).notNull().default(''),
    tags: jsonb('tags').$type<InternalVideoTags>().notNull(),
    durationSec: integer('duration_sec').notNull().default(0),
    videoKey: varchar('video_key', { length: 300 }).notNull(),
    posterKey: varchar('poster_key', { length: 300 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('published'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
)

/**
 * 内部视频播放打点：只记录"播放多久"（totalWatchedSec）与"什么时候停止"（lastStoppedAt/stopCount）。
 * 原生 <video> 的 timeupdate/pause/ended 精确驱动，按 (session, toolCall, video) 维度 upsert。
 */
export const internalVideoEngagements = pgTable(
  'internal_video_engagements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').notNull().references(() => chatSessions.id, { onDelete: 'cascade' }),
    toolCallId: varchar('tool_call_id', { length: 120 }).notNull(),
    videoId: varchar('video_id', { length: 120 }).notNull(),
    videoVersion: varchar('video_version', { length: 120 }).notNull(),
    durationSec: integer('duration_sec').notNull().default(0),
    totalWatchedSec: integer('total_watched_sec').notNull().default(0),
    lastPositionSec: integer('last_position_sec').notNull().default(0),
    playStartedAt: timestamp('play_started_at', { withTimezone: true }),
    lastStoppedAt: timestamp('last_stopped_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    stopCount: integer('stop_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_internal_video_engagement_session_tool_video').on(
      table.sessionId,
      table.toolCallId,
      table.videoId,
    ),
    index('idx_internal_video_engagement_user_updated').on(table.userId, table.updatedAt),
    index('idx_internal_video_engagement_session_updated').on(table.sessionId, table.updatedAt),
  ],
)
