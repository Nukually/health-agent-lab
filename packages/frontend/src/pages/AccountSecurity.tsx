/**
 * AccountSecurity — 账号与安全二级页
 *
 * 入口：Profile 编辑页底部 → 此页
 * 内容：清空健康档案 / 注销账号
 */

import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import ClearMedicalDataDialog from '../components/account/ClearMedicalDataDialog.js'
import DeleteAccountWizard from '../components/account/DeleteAccountWizard.js'

export default function AccountSecurity() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [clearOpen, setClearOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(searchParams.get('delete') === '1')

  return (
    <div style={styles.container}>
      <div style={styles.scrollArea}>
        <button style={styles.backBtn} onClick={() => navigate('/profile?mode=edit')}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span>返回</span>
        </button>

        <div style={styles.header}>
          <h1 style={styles.title}>账号与安全</h1>
          <p style={styles.subtitle}>
            以下操作涉及数据永久删除，请谨慎操作。
          </p>
        </div>

        <div style={styles.section}>
          <div style={styles.row} onClick={() => setClearOpen(true)}>
            <div style={styles.rowContent}>
              <div style={styles.rowTitle}>清空健康档案</div>
              <div style={styles.rowDesc}>删除您的医疗档案和病历图片。账号、对话历史不受影响。</div>
            </div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </div>

          <div style={{ ...styles.row, ...styles.rowDanger }} onClick={() => setDeleteOpen(true)}>
            <div style={styles.rowContent}>
              <div style={{ ...styles.rowTitle, color: '#d93025' }}>注销账号</div>
              <div style={styles.rowDesc}>永久删除账号及全部数据，不可恢复。</div>
            </div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d93025" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </div>
        </div>
      </div>

      <ClearMedicalDataDialog
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        onSuccess={() => navigate('/profile?mode=edit')}
      />
      <DeleteAccountWizard open={deleteOpen} onClose={() => setDeleteOpen(false)} />
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100%',
    background: 'var(--color-bg-page)',
    display: 'flex',
    flexDirection: 'column' as const,
  },
  scrollArea: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '20px 20px calc(20px + var(--safe-area-bottom))',
    paddingTop: 'calc(20px + var(--safe-area-top))',
  },
  backBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    background: 'none',
    border: 'none',
    color: 'var(--color-text)',
    fontSize: 15,
    cursor: 'pointer',
    padding: 0,
    marginBottom: 20,
  },
  header: {
    marginBottom: 24,
  },
  title: {
    fontSize: 22,
    fontWeight: 600,
    margin: '0 0 6px',
    color: 'var(--color-text)',
  },
  subtitle: {
    fontSize: 13,
    color: 'var(--color-text-muted)',
    margin: 0,
    lineHeight: 1.6,
  },
  section: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '16px',
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: 12,
    cursor: 'pointer',
    transition: 'background 0.15s',
  },
  rowDanger: {
    borderColor: 'rgba(217, 48, 37, 0.3)',
  },
  rowContent: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: 500,
    color: 'var(--color-text)',
  },
  rowDesc: {
    fontSize: 12,
    color: 'var(--color-text-muted)',
    lineHeight: 1.5,
  },
}
