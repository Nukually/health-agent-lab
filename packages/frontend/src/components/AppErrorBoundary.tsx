import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportClientError } from '../utils/clientErrorReport.js'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
}

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const stack = [error.stack, info.componentStack].filter(Boolean).join('\n')
    reportClientError(error, {
      phase: 'react-error-boundary',
      stackOverride: stack,
    })
  }

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <div style={styles.title}>页面出了点小状况</div>
          <div style={styles.desc}>已经自动记录诊断信息，您可以刷新页面后继续使用。</div>
          <button style={styles.btn} onClick={this.handleReload}>
            刷新页面
          </button>
        </div>
      </div>
    )
  }
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    height: 'var(--app-height)',
    minHeight: 'var(--app-height)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    background: 'var(--color-bg)',
  },
  card: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 20,
    background: 'rgba(255,255,255,0.92)',
    padding: '28px 22px',
    boxShadow: '0 12px 40px rgba(0,0,0,0.08)',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    textAlign: 'center',
  },
  title: {
    fontSize: 18,
    fontWeight: 600,
    color: 'var(--color-text)',
  },
  desc: {
    fontSize: 14,
    lineHeight: 1.6,
    color: 'var(--color-text-muted)',
  },
  btn: {
    marginTop: 8,
    height: 42,
    borderRadius: 12,
    background: 'var(--color-brand)',
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    border: 'none',
    cursor: 'pointer',
  },
}
