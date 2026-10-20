import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../services/api.js'
import { compressImage } from '../utils/image.js'
import type {
  ApiResponse,
  InterventionAssetInput,
  InterventionMaterialBulkPromoteResponse,
  InterventionMaterialDetailResponse,
  InterventionMaterialEditorDraft,
  InterventionMaterialEnvPresence,
  InterventionMaterialListItem,
  InterventionMaterialPromoteResponse,
  InterventionMaterialRecord,
  InterventionMaterialSaveRequest,
  InterventionTargetEnv,
} from '@health-agent/shared'

type BulkSyncTarget = Exclude<InterventionTargetEnv, 'dev'>

type View = 'list' | 'edit'
type EditorSection = 'trigger' | 'overview' | 'steps'

type SaveValidation =
  | { ok: true }
  | {
    ok: false
    message: string
    section: EditorSection
    stepIndex?: number
  }

const SECTION_TABS: Array<{ key: EditorSection; label: string }> = [
  { key: 'trigger', label: '触发条件' },
  { key: 'overview', label: '总览图' },
  { key: 'steps', label: '步骤' },
]

const EMPTY_DRAFT: InterventionMaterialEditorDraft = {
  materialId: '',
  sideEffect: '',
  scene: '',
  actionName: '',
  prepareItems: [],
  precheckQuestion: '',
  feedbackQuestion: '',
  effectiveRule: '',
  fallbackAction: '',
  redFlags: [],
  safetyNote: '',
  overviewImage: { kind: 'upload', dataUrl: '' },
  overviewPreviewUrl: '',
  steps: [
    {
      stepIndex: 1,
      durationSec: '10',
      displayText: '',
      image: { kind: 'upload', dataUrl: '' },
      previewUrl: '',
    },
  ],
}

function cloneDraft(source: InterventionMaterialEditorDraft): InterventionMaterialEditorDraft {
  return {
    ...source,
    overviewImage: { ...source.overviewImage },
    prepareItems: [...source.prepareItems],
    redFlags: [...source.redFlags],
    steps: source.steps.map((step) => ({
      ...step,
      image: { ...step.image },
    })),
  }
}

function recordToDraft(record: InterventionMaterialRecord): InterventionMaterialEditorDraft {
  return {
    materialId: record.materialId,
    sideEffect: record.sideEffect,
    scene: record.scene,
    actionName: record.actionName,
    prepareItems: [...record.prepareItems],
    precheckQuestion: record.precheckQuestion,
    feedbackQuestion: record.feedbackQuestion,
    effectiveRule: record.effectiveRule,
    fallbackAction: record.fallbackAction,
    redFlags: [...record.redFlags],
    safetyNote: record.safetyNote,
    overviewImage: {
      kind: 'existing',
      key: record.overviewAsset.key,
    },
    overviewPreviewUrl: record.overviewAsset.url,
    steps: record.steps
      .slice()
      .sort((a, b) => a.stepIndex - b.stepIndex)
      .map((step) => ({
        stepIndex: step.stepIndex,
        durationSec: String(step.durationSec),
        displayText: step.displayText,
        image: {
          kind: 'existing',
          key: step.imageAsset.key,
        },
        previewUrl: step.imageAsset.url,
      })),
  }
}

function refreshAssetPreviewUrl(
  asset: InterventionAssetInput,
  previewUrl: string | undefined,
  freshAsset: InterventionAssetInput | undefined,
  freshPreviewUrl: string | undefined,
): { asset: InterventionAssetInput; previewUrl?: string } {
  if (asset.kind === 'upload') {
    return {
      asset: { ...asset },
      previewUrl: asset.dataUrl || previewUrl,
    }
  }

  if (freshAsset?.kind === 'existing') {
    return {
      asset: freshAsset.key === asset.key ? { ...asset } : { ...freshAsset },
      previewUrl: freshPreviewUrl || previewUrl,
    }
  }

  return {
    asset: { ...asset },
    previewUrl,
  }
}

function refreshDraftPreviewUrls(
  draft: InterventionMaterialEditorDraft,
  freshDraft: InterventionMaterialEditorDraft,
): InterventionMaterialEditorDraft {
  const overview = refreshAssetPreviewUrl(
    draft.overviewImage,
    draft.overviewPreviewUrl,
    freshDraft.overviewImage,
    freshDraft.overviewPreviewUrl,
  )

  return {
    ...cloneDraft(draft),
    overviewImage: overview.asset,
    overviewPreviewUrl: overview.previewUrl,
    steps: draft.steps.map((step, index) => {
      const existingKey = step.image.kind === 'existing' ? step.image.key : null
      const freshStepByKey = existingKey
        ? freshDraft.steps.find((candidate) => (
          candidate.image.kind === 'existing'
          && candidate.image.key === existingKey
        ))
        : undefined
      const freshStep = freshStepByKey ?? freshDraft.steps[index]
      const image = refreshAssetPreviewUrl(
        step.image,
        step.previewUrl,
        freshStep?.image,
        freshStep?.previewUrl,
      )

      return {
        ...step,
        image: image.asset,
        previewUrl: image.previewUrl,
      }
    }),
  }
}

const DRAFT_STORAGE_PREFIX = 'materialsAdmin:draft'

function draftStorageKey(materialId: string | null): string {
  return materialId ? `${DRAFT_STORAGE_PREFIX}:edit:${materialId}` : `${DRAFT_STORAGE_PREFIX}:new`
}

function loadDraftFromStorage(materialId: string | null): InterventionMaterialEditorDraft | null {
  try {
    const raw = localStorage.getItem(draftStorageKey(materialId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as { draft?: InterventionMaterialEditorDraft }
    if (!parsed?.draft) return null
    return cloneDraft(parsed.draft)
  } catch {
    return null
  }
}

function saveDraftToStorage(materialId: string | null, draft: InterventionMaterialEditorDraft): void {
  try {
    localStorage.setItem(
      draftStorageKey(materialId),
      JSON.stringify({ draft, savedAt: Date.now() }),
    )
  } catch {
    // QuotaExceededError 等静默降级，不阻塞编辑
  }
}

function clearDraftFromStorage(materialId: string | null): void {
  try {
    localStorage.removeItem(draftStorageKey(materialId))
  } catch {
    // ignore
  }
}

function ensureAssetInput(
  asset: InterventionAssetInput,
  previewUrl?: string,
): InterventionAssetInput {
  if (asset.kind === 'upload' && !asset.dataUrl && previewUrl) {
    return { kind: 'upload', dataUrl: previewUrl }
  }
  return asset
}

function draftToRequest(draft: InterventionMaterialEditorDraft): InterventionMaterialSaveRequest {
  return {
    sideEffect: draft.sideEffect.trim(),
    scene: draft.scene.trim(),
    actionName: draft.actionName.trim(),
    prepareItems: [...draft.prepareItems],
    precheckQuestion: draft.precheckQuestion.trim(),
    feedbackQuestion: draft.feedbackQuestion.trim(),
    effectiveRule: draft.effectiveRule.trim(),
    fallbackAction: draft.fallbackAction.trim(),
    redFlags: [...draft.redFlags],
    safetyNote: draft.safetyNote.trim(),
    overviewImage: ensureAssetInput(draft.overviewImage, draft.overviewPreviewUrl),
    steps: draft.steps.map((step, index) => ({
      stepIndex: index + 1,
      durationSec: Number.parseInt(step.durationSec, 10),
      displayText: step.displayText.trim(),
      ttsText: step.displayText.trim(),
      image: ensureAssetInput(step.image, step.previewUrl),
    })),
  }
}

interface EnvBadgeInfo {
  label: string
  background: string
  color: string
  outdated: boolean
}

function envBadgeFromPresence(
  envPresence: InterventionMaterialEnvPresence | undefined,
  currentVersion: string,
): EnvBadgeInfo {
  const prod = envPresence?.prod ?? null
  const sit = envPresence?.sit ?? null
  if (prod) {
    const outdated = prod.version !== currentVersion
    return {
      label: outdated ? 'PROD（旧版）' : 'PROD',
      background: outdated ? 'rgba(220, 38, 38, 0.10)' : 'rgba(34, 139, 92, 0.14)',
      color: outdated ? '#B91C1C' : '#15803D',
      outdated,
    }
  }
  if (sit) {
    const outdated = sit.version !== currentVersion
    return {
      label: outdated ? 'SIT（旧版）' : 'SIT',
      background: outdated ? 'rgba(220, 38, 38, 0.10)' : 'rgba(37, 99, 235, 0.14)',
      color: outdated ? '#B91C1C' : '#1D4ED8',
      outdated,
    }
  }
  return {
    label: 'DEV',
    background: 'rgba(212, 135, 108, 0.14)',
    color: '#A95B3E',
    outdated: false,
  }
}

async function compressAsset(file: File): Promise<string> {
  return compressImage(file, 1400, 0.82)
}

function validateDraftForSave(draft: InterventionMaterialEditorDraft): SaveValidation {
  if (!draft.actionName.trim()) {
    return { ok: false, section: 'trigger', message: '请先填写干预名称' }
  }
  if (!draft.sideEffect.trim()) {
    return { ok: false, section: 'trigger', message: '请先填写副作用' }
  }
  if (!draft.scene.trim()) {
    return { ok: false, section: 'trigger', message: '请先填写细分场景' }
  }
  if (draft.overviewImage.kind === 'upload' && !draft.overviewImage.dataUrl) {
    return { ok: false, section: 'overview', message: '请先上传总览图' }
  }
  if (draft.steps.length === 0) {
    return { ok: false, section: 'steps', message: '请至少添加 1 个步骤' }
  }

  for (let index = 0; index < draft.steps.length; index += 1) {
    const step = draft.steps[index]
    const stepNo = index + 1
    const durationText = step.durationSec.trim()
    const durationSec = Number.parseInt(durationText, 10)
    if (!/^\d+$/.test(durationText) || !Number.isInteger(durationSec) || durationSec <= 0) {
      return { ok: false, section: 'steps', stepIndex: index, message: `请检查步骤 ${stepNo} 的时长` }
    }
    if (!step.displayText.trim()) {
      return { ok: false, section: 'steps', stepIndex: index, message: `请填写步骤 ${stepNo} 的展示文案` }
    }
    if (step.image.kind === 'upload' && !step.image.dataUrl) {
      return { ok: false, section: 'steps', stepIndex: index, message: `请上传步骤 ${stepNo} 的图片` }
    }
  }

  return { ok: true }
}

export default function MaterialsAdmin() {
  const navigate = useNavigate()
  const [view, setView] = useState<View>('list')
  const [items, setItems] = useState<InterventionMaterialListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [bulkSyncing, setBulkSyncing] = useState<BulkSyncTarget | null>(null)
  const [bulkConfirm, setBulkConfirm] = useState<BulkSyncTarget | null>(null)
  const [bulkResult, setBulkResult] = useState<InterventionMaterialBulkPromoteResponse | null>(null)

  useEffect(() => {
    if (!successMsg) return
    const timer = setTimeout(() => setSuccessMsg(null), 3500)
    return () => clearTimeout(timer)
  }, [successMsg])
  const [draft, setDraft] = useState<InterventionMaterialEditorDraft>(() => cloneDraft(EMPTY_DRAFT))
  const [editingMaterialId, setEditingMaterialId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [promotingEnv, setPromotingEnv] = useState<InterventionTargetEnv | null>(null)
  const [activeSection, setActiveSection] = useState<EditorSection>('trigger')
  const [activeStepIndex, setActiveStepIndex] = useState(0)
  const [draftRecovered, setDraftRecovered] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void loadItems()
  }, [])

  useEffect(() => {
    if (view !== 'edit') return
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current)
    draftSaveTimerRef.current = setTimeout(() => {
      saveDraftToStorage(editingMaterialId, draft)
    }, 500)
    return () => {
      if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current)
    }
  }, [draft, editingMaterialId, view])

  async function loadItems() {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<ApiResponse<{ items: InterventionMaterialListItem[] }>>('/intervention-materials')
      setItems(res.data?.items ?? [])
      setUnavailable(null)
    } catch (err: any) {
      const status = err?.status as number | undefined
      if (status === 403 || status === 404) {
        setUnavailable(err.message || '当前环境不可用')
      } else {
        setError(err.message || '加载失败')
      }
    } finally {
      setLoading(false)
    }
  }

  async function handleBulkSync(targetEnv: BulkSyncTarget) {
    if (bulkSyncing) return
    setBulkConfirm(null)
    setBulkSyncing(targetEnv)
    setError(null)
    setSuccessMsg(null)
    try {
      const res = await api.post<ApiResponse<InterventionMaterialBulkPromoteResponse>>(
        '/intervention-materials/sync-all',
        { targetEnv },
      )
      if (res.data) setBulkResult(res.data)
      await loadItems()
    } catch (err: any) {
      setError(err.message || `批量发布到 ${targetEnv.toUpperCase()} 失败`)
    } finally {
      setBulkSyncing(null)
    }
  }

  async function openEditor(materialId: string) {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<ApiResponse<InterventionMaterialDetailResponse>>(
        `/intervention-materials/${encodeURIComponent(materialId)}`,
      )
      const material = res.data?.material
      if (!material) throw new Error('素材不存在')
      const freshDraft = recordToDraft(material)
      const local = loadDraftFromStorage(material.materialId)
      if (local) {
        setDraft(refreshDraftPreviewUrls(local, freshDraft))
        setDraftRecovered(true)
      } else {
        setDraft(freshDraft)
        setDraftRecovered(false)
      }
      setEditingMaterialId(material.materialId)
      setActiveSection('trigger')
      setActiveStepIndex(0)
      setView('edit')
    } catch (err: any) {
      setError(err.message || '加载详情失败')
    } finally {
      setLoading(false)
    }
  }

  function startNewMaterial() {
    const local = loadDraftFromStorage(null)
    setDraft(local ?? cloneDraft(EMPTY_DRAFT))
    setDraftRecovered(Boolean(local))
    setEditingMaterialId(null)
    setActiveSection('trigger')
    setActiveStepIndex(0)
    setError(null)
    setView('edit')
  }

  function discardDraft() {
    clearDraftFromStorage(editingMaterialId)
    if (editingMaterialId) {
      void openEditor(editingMaterialId)
    } else {
      setDraft(cloneDraft(EMPTY_DRAFT))
    }
    setDraftRecovered(false)
  }

  function updateDraft<K extends keyof InterventionMaterialEditorDraft>(
    key: K,
    value: InterventionMaterialEditorDraft[K],
  ) {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  function updateStep(
    index: number,
    updater: (step: InterventionMaterialEditorDraft['steps'][number]) => InterventionMaterialEditorDraft['steps'][number],
  ) {
    setDraft((prev) => ({
      ...prev,
      steps: prev.steps
        .map((step, idx) => (idx === index ? updater(step) : step))
        .map((step, idx) => ({ ...step, stepIndex: idx + 1 })),
    }))
  }

  function addStep() {
    setDraft((prev) => ({
      ...prev,
      steps: [
        ...prev.steps,
        {
          stepIndex: prev.steps.length + 1,
          durationSec: '10',
          displayText: '',
          image: { kind: 'upload', dataUrl: '' },
          previewUrl: '',
        },
      ],
    }))
    setActiveSection('steps')
    setActiveStepIndex(draft.steps.length)
  }

  function removeStep(index: number) {
    setDraft((prev) => {
      const nextSteps = prev.steps.filter((_, idx) => idx !== index)
      return {
        ...prev,
        steps: nextSteps.map((step, idx) => ({ ...step, stepIndex: idx + 1 })),
      }
    })
    setActiveStepIndex((prev) => Math.max(0, prev > index ? prev - 1 : Math.min(prev, draft.steps.length - 2)))
  }

  async function handleOverviewFileChange(file?: File) {
    if (!file) return
    try {
      const dataUrl = await compressAsset(file)
      setDraft((prev) => ({
        ...prev,
        overviewImage: { kind: 'upload', dataUrl },
        overviewPreviewUrl: dataUrl,
      }))
    } catch {
      setError('总览图处理失败，请重试')
    }
  }

  async function handleStepFileChange(index: number, file?: File) {
    if (!file) return
    try {
      const dataUrl = await compressAsset(file)
      updateStep(index, (step) => ({
        ...step,
        image: { kind: 'upload', dataUrl },
        previewUrl: dataUrl,
      }))
    } catch {
      setError('步骤图片处理失败，请重试')
    }
  }

  const saveValidation = useMemo(() => validateDraftForSave(draft), [draft])

  const activeStep = draft.steps[activeStepIndex] ?? null

  async function handleSave() {
    if (saving || promotingEnv) return
    if (!saveValidation.ok) {
      setError(saveValidation.message)
      setActiveSection(saveValidation.section)
      if (typeof saveValidation.stepIndex === 'number') {
        setActiveStepIndex(saveValidation.stepIndex)
      }
      return
    }
    setSaving(true)
    setError(null)
    const payload = draftToRequest(draft)
    try {
      const res = editingMaterialId
        ? await api.put<ApiResponse<InterventionMaterialDetailResponse>>(
          `/intervention-materials/${encodeURIComponent(editingMaterialId)}`,
          payload,
        )
        : await api.post<ApiResponse<InterventionMaterialDetailResponse>>(
          '/intervention-materials',
          payload,
        )
      const material = res.data?.material
      if (!material) throw new Error('保存失败')
      const previousId = editingMaterialId
      setDraft(recordToDraft(material))
      setEditingMaterialId(material.materialId)
      setDraftRecovered(false)
      clearDraftFromStorage(null)
      clearDraftFromStorage(previousId)
      clearDraftFromStorage(material.materialId)
      await loadItems()
    } catch (err: any) {
      setError(err.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!editingMaterialId) return
    setConfirmingDelete(false)
    setSaving(true)
    setError(null)
    try {
      await api.post<ApiResponse<InterventionMaterialDetailResponse>>(
        `/intervention-materials/${encodeURIComponent(editingMaterialId)}/archive`,
      )
      clearDraftFromStorage(editingMaterialId)
      await loadItems()
      setDraft(cloneDraft(EMPTY_DRAFT))
      setEditingMaterialId(null)
      setDraftRecovered(false)
      setActiveSection('trigger')
      setActiveStepIndex(0)
      setView('list')
    } catch (err: any) {
      setError(err.message || '删除失败')
    } finally {
      setSaving(false)
    }
  }

  async function handlePromote(targetEnv: Exclude<InterventionTargetEnv, 'dev'>) {
    if (!editingMaterialId || promotingEnv) return
    setPromotingEnv(targetEnv)
    setError(null)
    setSuccessMsg(null)
    try {
      const res = await api.post<ApiResponse<InterventionMaterialPromoteResponse>>(
        `/intervention-materials/${encodeURIComponent(editingMaterialId)}/promote`,
        { targetEnv },
      )
      const version = res?.data?.version
      const label = targetEnv.toUpperCase()
      setSuccessMsg(version ? `已发布到 ${label}（版本 ${version}）` : `已发布到 ${label}`)
      await loadItems()
    } catch (err: any) {
      setError(err.message || `发布到 ${targetEnv} 失败`)
    } finally {
      setPromotingEnv(null)
    }
  }

  function renderEditorSection() {
    switch (activeSection) {
      case 'trigger':
        return (
          <div style={styles.sectionBody}>
            <div style={styles.idCard}>
              <div style={styles.idLabel}>素材 ID</div>
              <div style={styles.idValue}>{draft.materialId || '保存后自动生成'}</div>
              <div style={styles.idHint}>创建时由系统自动生成，后续编辑保持不变。</div>
            </div>
            <label style={styles.label}>
              干预名称
              <input
                style={styles.input}
                value={draft.actionName}
                onChange={(e) => updateDraft('actionName', e.target.value)}
                placeholder="例如 呕吐后漱口+坐位恢复"
              />
            </label>
            <div style={styles.grid2}>
              <label style={styles.label}>
                副作用
                <input
                  style={styles.input}
                  value={draft.sideEffect}
                  onChange={(e) => updateDraft('sideEffect', e.target.value)}
                />
              </label>
              <label style={styles.label}>
                细分场景
                <input
                  style={styles.input}
                  value={draft.scene}
                  onChange={(e) => updateDraft('scene', e.target.value)}
                />
              </label>
            </div>
          </div>
        )
      case 'overview':
        return (
          <div style={styles.sectionBody}>
            <label style={styles.label}>
              总览图
              <input
                style={styles.fileInput}
                type="file"
                accept="image/*"
                onChange={(e) => void handleOverviewFileChange(e.target.files?.[0])}
              />
            </label>
            {draft.overviewPreviewUrl ? (
              <img src={draft.overviewPreviewUrl} alt="总览图预览" style={styles.imagePreview} />
            ) : (
              <div style={styles.imagePlaceholder}>请上传 1 张总览图</div>
            )}
          </div>
        )
      case 'steps':
        return (
          <div style={{ ...styles.sectionBody, ...styles.stepSectionBody }}>
            <div style={styles.stepToolbar}>
              <div style={styles.stepTabs}>
                {draft.steps.map((step, index) => (
                  <button
                    key={step.stepIndex}
                    type="button"
                    style={{
                      ...styles.stepTab,
                      ...(activeStepIndex === index ? styles.stepTabActive : null),
                    }}
                    onClick={() => setActiveStepIndex(index)}
                  >
                    步骤 {index + 1}
                  </button>
                ))}
              </div>
              <button style={styles.secondaryBtn} type="button" onClick={addStep}>新增步骤</button>
            </div>
            {activeStep && (
              <div style={styles.stepCard}>
                <div style={styles.stepHeader}>
                  <strong>当前编辑：步骤 {activeStepIndex + 1}</strong>
                  {draft.steps.length > 1 && (
                    <button style={styles.linkBtn} type="button" onClick={() => removeStep(activeStepIndex)}>
                      删除该步骤
                    </button>
                  )}
                </div>
                <label style={styles.label}>
                  时长（秒）
                  <input
                    style={styles.input}
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={activeStep.durationSec}
                    onChange={(e) => updateStep(activeStepIndex, (current) => ({
                      ...current,
                      durationSec: e.target.value.replace(/\D+/g, ''),
                    }))}
                  />
                </label>
                <label style={styles.label}>
                  展示文案
                  <textarea
                    style={styles.textarea}
                    rows={3}
                    value={activeStep.displayText}
                    onChange={(e) => updateStep(activeStepIndex, (current) => ({ ...current, displayText: e.target.value }))}
                  />
                </label>
                <label style={styles.label}>
                  步骤图片
                  <input
                    style={styles.fileInput}
                    type="file"
                    accept="image/*"
                    onChange={(e) => void handleStepFileChange(activeStepIndex, e.target.files?.[0])}
                  />
                </label>
                {activeStep.previewUrl ? (
                  <img src={activeStep.previewUrl} alt={`步骤 ${activeStepIndex + 1} 预览`} style={styles.imagePreview} />
                ) : (
                  <div style={styles.imagePlaceholder}>请上传当前步骤图片</div>
                )}
              </div>
            )}
          </div>
        )
      default:
        return null
    }
  }

  if (unavailable) {
    return (
      <div style={styles.page}>
        <div style={styles.content}>
          <h1 style={styles.title}>素材上传台</h1>
          <p style={styles.subtitle}>{unavailable}</p>
          <p style={styles.helper}>仅 local / dev 环境开放，且需要 allowlist 账号访问；local 环境仍限制局域网。</p>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.page}>
      <div style={styles.content}>
        <div style={styles.header}>
          <div>
            <h1 style={styles.title}>素材上传台</h1>
            <p style={styles.subtitle}>仅供内部录入、预生成音频与环境发布使用</p>
          </div>
          <div style={styles.headerActions}>
            {view === 'list' ? (
              <button style={styles.primaryBtn} onClick={startNewMaterial}>新建素材</button>
            ) : (
              <button
                style={styles.secondaryBtn}
                onClick={() => {
                  setView('list')
                  setError(null)
                }}
              >
                返回列表
              </button>
            )}
            <button
              type="button"
              style={styles.secondaryBtn}
              onClick={() => navigate('/chat')}
            >
              返回聊天
            </button>
          </div>
        </div>

        {error && <div style={styles.error}>{error}</div>}
        {successMsg && <div style={styles.success}>{successMsg}</div>}
        {view === 'edit' && draftRecovered && (
          <div style={styles.draftBanner}>
            <span>已恢复上次未保存的草稿</span>
            <button type="button" style={styles.draftBannerBtn} onClick={discardDraft}>丢弃草稿</button>
          </div>
        )}

        {view === 'list' ? (
          <div style={styles.listPage}>
            {!loading && items.length > 0 && (
              <div style={styles.bulkBar}>
                <button
                  type="button"
                  style={styles.secondaryBtn}
                  onClick={() => setBulkConfirm('sit')}
                  disabled={!!bulkSyncing}
                >
                  {bulkSyncing === 'sit' ? '全部同步到 SIT 中...' : '全部同步到 SIT'}
                </button>
                <button
                  type="button"
                  style={styles.secondaryBtn}
                  onClick={() => setBulkConfirm('prod')}
                  disabled={!!bulkSyncing}
                >
                  {bulkSyncing === 'prod' ? '全部同步到 PROD 中...' : '全部同步到 PROD'}
                </button>
              </div>
            )}
            {loading ? (
              <div style={styles.empty}>加载中...</div>
            ) : items.length === 0 ? (
              <div style={styles.empty}>暂无素材，点击右上角新建</div>
            ) : (
              <div style={styles.list}>
                {items.map((item) => {
                  const badge = envBadgeFromPresence(item.envPresence, item.version)
                  return (
                    <button
                      key={item.materialId}
                      type="button"
                      style={styles.card}
                      onClick={() => void openEditor(item.materialId)}
                    >
                      <div style={styles.cardTop}>
                        <span style={styles.cardTitle}>{item.actionName}</span>
                        <span
                          style={{
                            ...styles.badge,
                            background: badge.background,
                            color: badge.color,
                          }}
                        >
                          {badge.label}
                        </span>
                      </div>
                      <div style={styles.cardMeta}>{item.sideEffect} · {item.scene}</div>
                      <div style={styles.cardMeta}>ID: {item.materialId}</div>
                      <div style={styles.cardMeta}>版本 {item.version}</div>
                      {item.envPresence && (item.envPresence.sit || item.envPresence.prod) && (
                        <div style={styles.cardMeta}>
                          {item.envPresence.sit && (
                            <span>SIT v{item.envPresence.sit.version.slice(-8)}</span>
                          )}
                          {item.envPresence.sit && item.envPresence.prod && <span> · </span>}
                          {item.envPresence.prod && (
                            <span>PROD v{item.envPresence.prod.version.slice(-8)}</span>
                          )}
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        ) : (
          <div style={styles.editorShell}>
            <div style={styles.tabBar}>
              {SECTION_TABS.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  style={{
                    ...styles.tabBtn,
                    ...(activeSection === tab.key ? styles.tabBtnActive : null),
                  }}
                  onClick={() => setActiveSection(tab.key)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <section style={styles.panel}>
              <div style={styles.panelHeader}>{SECTION_TABS.find((tab) => tab.key === activeSection)?.label}</div>
              <div style={styles.panelBody}>{renderEditorSection()}</div>
            </section>

            <div style={styles.footerBar}>
              {editingMaterialId && (
                <>
                  <button
                    style={styles.secondaryBtn}
                    type="button"
                    onClick={() => void handlePromote('sit')}
                    disabled={!!promotingEnv || saving}
                  >
                    {promotingEnv === 'sit' ? '发布到 SIT 中...' : '发布到 SIT'}
                  </button>
                  <button
                    style={styles.secondaryBtn}
                    type="button"
                    onClick={() => void handlePromote('prod')}
                    disabled={!!promotingEnv || saving}
                  >
                    {promotingEnv === 'prod' ? '发布到 PROD 中...' : '发布到 PROD'}
                  </button>
                  <button
                    style={styles.dangerBtn}
                    type="button"
                    onClick={() => setConfirmingDelete(true)}
                    disabled={saving || !!promotingEnv}
                  >
                    删除
                  </button>
                </>
              )}
              <button
                style={styles.primaryBtn}
                type="button"
                onClick={() => void handleSave()}
                disabled={saving || !!promotingEnv}
              >
                {saving ? '保存中...' : '保存到 DEV'}
              </button>
            </div>
            {!saveValidation.ok && !saving && (
              <div style={styles.footerHint}>保存前需补充：{saveValidation.message}</div>
            )}
          </div>
        )}
      </div>
      {confirmingDelete && (
        <div style={styles.modalMask} onClick={() => !saving && setConfirmingDelete(false)}>
          <div style={styles.modalCard} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalTitle}>删除素材</div>
            <div style={styles.modalBody}>
              确定删除「<strong>{draft.actionName || editingMaterialId}</strong>」吗？
              <br />
              删除后不再展示在列表中，如需恢复请联系开发同学。
            </div>
            <div style={styles.modalActions}>
              <button
                type="button"
                style={styles.modalCancelBtn}
                onClick={() => setConfirmingDelete(false)}
                disabled={saving}
              >
                取消
              </button>
              <button
                type="button"
                style={styles.modalConfirmBtn}
                onClick={() => void handleDelete()}
                disabled={saving}
              >
                {saving ? '删除中...' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}
      {bulkConfirm && (
        <div style={styles.modalMask} onClick={() => !bulkSyncing && setBulkConfirm(null)}>
          <div style={styles.modalCard} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalTitle}>全部同步到 {bulkConfirm.toUpperCase()}</div>
            <div style={styles.modalBody}>
              将列表中所有素材的当前 DEV 版本同步到 <strong>{bulkConfirm.toUpperCase()}</strong>。
              {bulkConfirm === 'prod' && (
                <>
                  <br />
                  PROD 同步会先确保 SIT 版本一致，再发布到 PROD。
                </>
              )}
              <br />
              将逐条执行，结束后展示成功 / 失败清单。
            </div>
            <div style={styles.modalActions}>
              <button
                type="button"
                style={styles.modalCancelBtn}
                onClick={() => setBulkConfirm(null)}
                disabled={!!bulkSyncing}
              >
                取消
              </button>
              <button
                type="button"
                style={styles.modalConfirmBtn}
                onClick={() => void handleBulkSync(bulkConfirm)}
                disabled={!!bulkSyncing}
              >
                {bulkSyncing ? '同步中...' : '确认同步'}
              </button>
            </div>
          </div>
        </div>
      )}
      {bulkResult && (
        <div style={styles.modalMask} onClick={() => setBulkResult(null)}>
          <div style={styles.modalCard} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalTitle}>
              同步到 {bulkResult.targetEnv.toUpperCase()} 结果
            </div>
            <div style={styles.modalBody}>
              成功 {bulkResult.succeeded.length} 条，失败 {bulkResult.failed.length} 条。
              {bulkResult.succeeded.length > 0 && (
                <div style={styles.bulkResultGroup}>
                  <div style={styles.bulkResultGroupTitle}>成功</div>
                  <ul style={styles.bulkResultList}>
                    {bulkResult.succeeded.map((item) => (
                      <li key={item.materialId} style={styles.bulkResultItem}>
                        {item.actionName}（{item.materialId}）
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {bulkResult.failed.length > 0 && (
                <div style={styles.bulkResultGroup}>
                  <div style={{ ...styles.bulkResultGroupTitle, color: '#B91C1C' }}>失败</div>
                  <ul style={styles.bulkResultList}>
                    {bulkResult.failed.map((item) => (
                      <li key={item.materialId} style={styles.bulkResultItem}>
                        {item.actionName}（{item.materialId}）：{item.error}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <div style={styles.modalActions}>
              <button
                type="button"
                style={styles.modalConfirmBtn}
                onClick={() => setBulkResult(null)}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    height: '100%',
    background: 'var(--color-bg)',
  },
  content: {
    height: '100%',
    maxWidth: 880,
    margin: '0 auto',
    padding: 'calc(16px + var(--safe-area-top)) 16px calc(20px + var(--safe-area-bottom))',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 12,
    flexShrink: 0,
  },
  headerActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  title: {
    fontSize: 26,
    fontWeight: 700,
    margin: '0 0 6px',
    color: 'var(--color-text)',
  },
  subtitle: {
    margin: 0,
    fontSize: 14,
    color: 'var(--color-text-muted)',
  },
  helper: {
    fontSize: 13,
    color: 'var(--color-text-muted)',
  },
  primaryBtn: {
    border: 'none',
    borderRadius: 12,
    padding: '10px 14px',
    background: 'var(--color-primary)',
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    flexShrink: 0,
  },
  secondaryBtn: {
    border: '1px solid var(--color-border)',
    borderRadius: 12,
    padding: '10px 14px',
    background: '#fff',
    color: 'var(--color-text)',
    fontSize: 14,
    cursor: 'pointer',
    flexShrink: 0,
  },
  dangerBtn: {
    border: '1px solid rgba(229,72,72,0.22)',
    borderRadius: 12,
    padding: '10px 14px',
    background: 'rgba(229,72,72,0.08)',
    color: '#C63B3B',
    fontSize: 14,
    cursor: 'pointer',
    flexShrink: 0,
  },
  error: {
    marginBottom: 12,
    padding: '10px 12px',
    borderRadius: 12,
    background: 'var(--color-error-bg)',
    color: 'var(--color-error)',
    fontSize: 13,
    flexShrink: 0,
  },
  success: {
    marginBottom: 12,
    padding: '10px 12px',
    borderRadius: 12,
    background: 'rgba(46, 160, 67, 0.12)',
    color: '#1a7f37',
    fontSize: 13,
    flexShrink: 0,
  },
  draftBanner: {
    marginBottom: 12,
    padding: '8px 12px',
    borderRadius: 12,
    background: 'rgba(245, 158, 11, 0.12)',
    color: '#92400e',
    fontSize: 13,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    flexShrink: 0,
  },
  draftBannerBtn: {
    border: 'none',
    background: 'transparent',
    color: '#92400e',
    fontSize: 13,
    cursor: 'pointer',
    textDecoration: 'underline',
    padding: 0,
  },
  modalMask: {
    position: 'fixed' as const,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    background: 'rgba(15, 23, 42, 0.45)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 360,
    background: '#fff',
    borderRadius: 16,
    padding: '20px 20px 16px',
    boxShadow: '0 20px 40px rgba(15, 23, 42, 0.18)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: 600,
    color: 'var(--color-text)',
  },
  modalBody: {
    fontSize: 14,
    lineHeight: 1.6,
    color: 'var(--color-text-secondary)',
  },
  modalActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 4,
  },
  modalCancelBtn: {
    height: 36,
    minWidth: 72,
    padding: '0 16px',
    borderRadius: 10,
    border: '1px solid var(--color-border)',
    background: '#fff',
    color: 'var(--color-text)',
    fontSize: 14,
    cursor: 'pointer',
  },
  modalConfirmBtn: {
    height: 36,
    minWidth: 88,
    padding: '0 16px',
    borderRadius: 10,
    border: 'none',
    background: '#dc2626',
    color: '#fff',
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
  },
  listPage: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    overflow: 'hidden',
  },
  bulkBar: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap' as const,
    flexShrink: 0,
  },
  bulkResultGroup: {
    marginTop: 12,
  },
  bulkResultGroupTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--color-text)',
    marginBottom: 6,
  },
  bulkResultList: {
    margin: 0,
    paddingLeft: 18,
    maxHeight: 160,
    overflowY: 'auto' as const,
  },
  bulkResultItem: {
    fontSize: 13,
    lineHeight: 1.6,
    color: 'var(--color-text-secondary)',
  },
  empty: {
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    color: 'var(--color-text-muted)',
    fontSize: 14,
  },
  list: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    overflowY: 'auto',
    paddingRight: 4,
  },
  card: {
    border: '1px solid var(--color-border)',
    borderRadius: 16,
    padding: 16,
    textAlign: 'left',
    background: '#fff',
    cursor: 'pointer',
  },
  cardTop: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 8,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--color-text)',
  },
  badge: {
    padding: '2px 8px',
    borderRadius: 999,
    background: 'rgba(212,135,108,0.12)',
    color: '#A95B3E',
    fontSize: 12,
    fontWeight: 600,
  },
  cardMeta: {
    fontSize: 13,
    color: 'var(--color-text-muted)',
    lineHeight: 1.6,
  },
  editorShell: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    overflow: 'hidden',
  },
  tabBar: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 8,
    flexShrink: 0,
  },
  tabBtn: {
    border: '1px solid var(--color-border)',
    borderRadius: 999,
    padding: '8px 12px',
    background: '#fff',
    color: 'var(--color-text-secondary)',
    fontSize: 13,
    fontWeight: 500,
  },
  tabBtnActive: {
    background: 'rgba(212,135,108,0.12)',
    color: '#A95B3E',
    border: '1px solid rgba(212,135,108,0.24)',
  },
  panel: {
    flex: 1,
    minHeight: 0,
    borderRadius: 18,
    background: '#fff',
    border: '1px solid var(--color-border)',
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  panelHeader: {
    fontSize: 16,
    fontWeight: 700,
    color: 'var(--color-text)',
    marginBottom: 12,
    flexShrink: 0,
  },
  panelBody: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  sectionBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    height: '100%',
    minHeight: 0,
  },
  stepSectionBody: {
    overflow: 'hidden',
  },
  idCard: {
    padding: 12,
    borderRadius: 14,
    background: 'rgba(212,135,108,0.08)',
    border: '1px solid rgba(212,135,108,0.18)',
  },
  idLabel: {
    fontSize: 12,
    color: 'var(--color-text-muted)',
    marginBottom: 6,
  },
  idValue: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--color-text)',
    wordBreak: 'break-all' as const,
  },
  idHint: {
    marginTop: 6,
    fontSize: 12,
    color: 'var(--color-text-muted)',
  },
  label: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    fontSize: 13,
    color: 'var(--color-text-secondary)',
  },
  input: {
    height: 40,
    borderRadius: 10,
    border: '1px solid var(--color-border)',
    padding: '0 12px',
    fontSize: 14,
    background: '#fff',
    color: 'var(--color-text)',
  },
  textarea: {
    borderRadius: 10,
    border: '1px solid var(--color-border)',
    padding: '10px 12px',
    fontSize: 14,
    background: '#fff',
    color: 'var(--color-text)',
    resize: 'none' as const,
    minHeight: 72,
  },
  fileInput: {
    fontSize: 13,
  },
  grid2: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 12,
  },
  imagePreview: {
    width: '100%',
    maxHeight: 220,
    objectFit: 'contain' as const,
    borderRadius: 12,
    border: '1px solid var(--color-border)',
    background: '#fff',
  },
  imagePlaceholder: {
    flex: 1,
    minHeight: 160,
    borderRadius: 12,
    border: '1px dashed var(--color-border)',
    color: 'var(--color-text-muted)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center' as const,
    padding: 16,
  },
  stepToolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    flexWrap: 'wrap' as const,
  },
  stepTabs: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 8,
  },
  stepTab: {
    border: '1px solid var(--color-border)',
    borderRadius: 999,
    padding: '6px 10px',
    background: '#fff',
    color: 'var(--color-text-secondary)',
    fontSize: 13,
  },
  stepTabActive: {
    background: 'rgba(212,135,108,0.12)',
    color: '#A95B3E',
    border: '1px solid rgba(212,135,108,0.24)',
  },
  stepCard: {
    flex: 1,
    minHeight: 0,
    padding: 12,
    borderRadius: 12,
    background: 'rgba(245,245,245,0.65)',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    overflowY: 'auto',
    paddingRight: 4,
    WebkitOverflowScrolling: 'touch',
  },
  stepHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  linkBtn: {
    border: 'none',
    background: 'transparent',
    color: '#C63B3B',
    fontSize: 13,
    cursor: 'pointer',
  },
  footerBar: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 10,
    flexWrap: 'wrap' as const,
    flexShrink: 0,
  },
  footerHint: {
    fontSize: 12,
    color: '#A95B3E',
    textAlign: 'right' as const,
    flexShrink: 0,
  },
}
