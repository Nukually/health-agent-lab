import { useEffect, useState, type CSSProperties } from 'react'

type Phase = 'running' | 'settling'

interface Props {
  loading?: boolean
  phase?: Phase
  /** 完成态：凝固成静态卡（无流动动画、无轮播），保留三专家+扫描质感 */
  done?: boolean
}

const RUNNING_STAGES = [
  '读取报告版面与关键字段',
  '核对数值、单位和阴阳性',
  '比对专家视角中的一致点',
  '标记看不清和需核对内容',
]

const SETTLING_STAGES = [
  '正在整理专家共识',
  '回到图片原文逐项复核',
  '压低不确定内容权重',
]

const EXPERTS = [
  { name: '原文核对专家', color: '#D4876C', delay: '0s' },
  { name: '指标解读专家', color: '#3D8F7C', delay: '0.18s' },
  { name: '安全复核专家', color: '#7C6FCE', delay: '0.36s' },
]

export default function MedicalReportConsultationInline({
  loading = false,
  phase = 'running',
  done = false,
}: Props) {
  const stages = phase === 'settling' ? SETTLING_STAGES : RUNNING_STAGES
  const [stageIndex, setStageIndex] = useState(0)

  useEffect(() => {
    if (!loading || done) return
    setStageIndex(0)
    const timer = window.setInterval(() => {
      setStageIndex((idx) => (idx + 1) % stages.length)
    }, 2600)
    return () => window.clearInterval(timer)
  }, [loading, done, stages.length])

  if (!loading && !done) return null

  const title = done
    ? '病历解读完成'
    : phase === 'settling' ? '正在整理共识' : '病历解析中'
  const caption = done
    ? '三位专家已交叉核对完成，结论已结合图片原文确认。'
    : phase === 'settling'
      ? '专家结果已返回，正在结合图片原文确认。'
      : '三位专家正在并行核对报告内容。'

  return (
    <div style={styles.wrapper}>
      <div
        className={done ? undefined : 'medical-consult-card'}
        style={done ? { ...styles.card, ...styles.cardDone } : styles.card}
      >
        {!done && <div className="medical-consult-scan" aria-hidden="true" />}
        <div style={styles.header}>
          <div style={styles.markWrap} aria-hidden="true">
            <div style={done ? { ...styles.markCore, ...styles.markCoreDone } : styles.markCore} />
            {done ? (
              <div style={styles.markBadge}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
            ) : (
              <div className="medical-consult-mark-ring" style={styles.markRing} />
            )}
          </div>
          <div style={styles.copy}>
            <div style={styles.title}>{title}</div>
            <div style={styles.caption}>{caption}</div>
          </div>
        </div>

        {!done && (
          <div style={styles.stageRow}>
            <span style={styles.stageDot} />
            <span style={styles.stageText}>{stages[stageIndex]}</span>
          </div>
        )}

        <div style={done ? { ...styles.lanes, ...styles.lanesDone } : styles.lanes}>
          {EXPERTS.map((expert) => (
            <div key={expert.name} style={done ? { ...styles.lane, ...styles.laneDone } : styles.lane}>
              {done ? (
                <>
                  <span style={{ ...styles.laneDot, background: expert.color }} />
                  <span style={styles.laneNameDone}>{expert.name}</span>
                  <svg style={styles.laneCheck} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={expert.color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </>
              ) : (
                <>
                  <div style={styles.laneTop}>
                    <span style={{ ...styles.laneSignal, background: expert.color }} />
                    <span style={styles.laneName}>{expert.name}</span>
                  </div>
                  <div style={styles.laneTrack}>
                    <div
                      className="medical-consult-lane-fill"
                      style={{
                        ...styles.laneFill,
                        background: expert.color,
                        animationDelay: expert.delay,
                      }}
                    />
                  </div>
                </>
              )}
            </div>
          ))}
        </div>

        {!done && (
          <div style={styles.progressTrack}>
            <div
              className="medical-consult-progress"
              style={{
                ...styles.progressFill,
                animationDuration: phase === 'settling' ? '2.4s' : '3.2s',
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  wrapper: {
    margin: '10px 0 12px',
    maxWidth: 520,
  },
  card: {
    position: 'relative',
    overflow: 'hidden',
    borderRadius: 8,
    border: '1px solid rgba(61, 143, 124, 0.18)',
    background: 'linear-gradient(135deg, rgba(255,255,255,0.98), rgba(255,247,241,0.94) 46%, rgba(238,249,246,0.96))',
    boxShadow: '0 10px 26px rgba(57, 70, 80, 0.10)',
    padding: 14,
  },
  cardDone: {
    border: '1px solid rgba(61, 143, 124, 0.24)',
    boxShadow: '0 6px 18px rgba(57, 70, 80, 0.07)',
    padding: 13,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 11,
    minWidth: 0,
    position: 'relative',
    zIndex: 1,
  },
  markWrap: {
    position: 'relative',
    width: 34,
    height: 34,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  markCore: {
    width: 18,
    height: 22,
    borderRadius: 5,
    border: '2px solid #D4876C',
    background: 'rgba(255, 255, 255, 0.8)',
    boxShadow: 'inset 0 -7px 0 rgba(212, 135, 108, 0.12)',
  },
  markCoreDone: {
    borderColor: '#3D8F7C',
    boxShadow: 'inset 0 -7px 0 rgba(61, 143, 124, 0.14)',
  },
  markBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 16,
    height: 16,
    borderRadius: 8,
    background: '#3D8F7C',
    border: '2px solid #fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 2px 5px rgba(61, 143, 124, 0.32)',
  },
  markRing: {
    position: 'absolute',
    inset: 0,
    borderRadius: 8,
    border: '1px solid rgba(61, 143, 124, 0.26)',
  },
  copy: {
    minWidth: 0,
  },
  title: {
    fontSize: 15,
    lineHeight: 1.35,
    fontWeight: 700,
    color: 'var(--color-text)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  caption: {
    marginTop: 2,
    fontSize: 12,
    lineHeight: 1.45,
    color: 'var(--color-text-secondary)',
    overflowWrap: 'anywhere',
  },
  stageRow: {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    minHeight: 24,
    marginTop: 12,
    padding: '6px 8px',
    borderRadius: 7,
    background: 'rgba(255, 255, 255, 0.58)',
  },
  stageDot: {
    width: 7,
    height: 7,
    borderRadius: 2,
    background: '#3D8F7C',
    boxShadow: '0 0 0 4px rgba(61, 143, 124, 0.10)',
    flexShrink: 0,
  },
  stageText: {
    fontSize: 12,
    color: 'var(--color-text)',
    fontWeight: 600,
    overflowWrap: 'anywhere',
  },
  lanes: {
    position: 'relative',
    zIndex: 1,
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 8,
    marginTop: 12,
  },
  lanesDone: {
    display: 'flex',
    flexDirection: 'column',
    gridTemplateColumns: undefined,
    gap: 6,
    marginTop: 11,
    padding: '10px 11px',
    borderRadius: 8,
    background: 'rgba(255, 255, 255, 0.5)',
  },
  laneDone: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: 0,
    border: 'none',
    background: 'transparent',
  },
  laneDot: {
    width: 7,
    height: 7,
    borderRadius: 2,
    flexShrink: 0,
  },
  laneNameDone: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    lineHeight: '18px',
    color: 'var(--color-text)',
    fontWeight: 600,
  },
  laneCheck: {
    flexShrink: 0,
  },
  lane: {
    minWidth: 0,
    borderRadius: 7,
    padding: '8px 7px',
    background: 'rgba(255, 255, 255, 0.62)',
    border: '1px solid rgba(51, 65, 85, 0.08)',
  },
  laneTop: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    minWidth: 0,
  },
  laneSignal: {
    width: 7,
    height: 7,
    borderRadius: 2,
    flexShrink: 0,
  },
  laneName: {
    fontSize: 11,
    lineHeight: 1.2,
    color: 'var(--color-text-secondary)',
    fontWeight: 700,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  laneTrack: {
    height: 4,
    marginTop: 7,
    borderRadius: 999,
    background: 'rgba(51, 65, 85, 0.10)',
    overflow: 'hidden',
  },
  laneFill: {
    height: '100%',
    width: '46%',
    borderRadius: 999,
    opacity: 0.78,
  },
  progressTrack: {
    position: 'relative',
    zIndex: 1,
    height: 5,
    marginTop: 12,
    borderRadius: 999,
    background: 'rgba(51, 65, 85, 0.10)',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    width: '42%',
    borderRadius: 999,
    background: 'linear-gradient(90deg, #D4876C, #3D8F7C, #7C6FCE)',
  },
}
