import { useState, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { api } from '../services/api.js'
import { useStore } from '../stores/index.js'
import { useVoiceRecorder } from '../hooks/useVoiceRecorder.js'
import {
  MENSTRUAL_STATUSES,
  NODULE_BIRADS_GRADES,
  TUMOR_TYPES,
  DIAGNOSIS_DURATIONS,
  TREATMENT_PHASES,
  SELECTABLE_MEDICATION_DURATIONS,
  MENSTRUAL_STATUS_LABELS,
  NODULE_BIRADS_GRADE_LABELS,
  TUMOR_TYPE_LABELS,
  DIAGNOSIS_DURATION_LABELS,
  TREATMENT_PHASE_LABELS,
  MEDICATION_LABELS,
  MEDICATION_DURATION_LABELS,
  MEDICATION_CUSTOM_NAME_MAX_LENGTH,
  formatMedicationDurationDetails,
  formatMedicationNames,
  normalizeMedicalProfileData,
  resolveMedicationItems,
  resolveVisibleMedicalFields,
} from '@health-agent/shared'
import type {
  ApiResponse,
  CurrentConcern,
  MedicalRecord,
  MedicalProfileData,
  MenstrualStatus,
  NoduleBiradsGrade,
  TumorType,
  DiagnosisDuration,
  TreatmentPhase,
  MedicationOption,
  SelectableMedicationDuration,
} from '@health-agent/shared'

interface Props {
  gender: string | null
  currentConcern: CurrentConcern | null
  initialData?: MedicalProfileData | null
  sessionId?: string
  onSaved?: (profileData: MedicalProfileData) => void
}

function normalizeMedicationCustomName(value: string): string {
  return value.trim().replace(/[。．.!！?？,，、;；：:]+$/u, '').trim()
}

function splitMedicationCustom(value: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value.split(/[、,，;；。！？!?\n\r]+/u)) {
    const trimmed = normalizeMedicationCustomName(item)
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

function joinMedicationCustom(items: string[]): string {
  return splitMedicationCustom(items.join('、')).join('、')
}

function getTextLength(value: string): number {
  return Array.from(value).length
}

function sliceText(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join('')
}

function getMedicationCustomValidationError(names: string[]): string {
  const tooLongName = names.find((name) => getTextLength(name) > MEDICATION_CUSTOM_NAME_MAX_LENGTH)
  return tooLongName ? `单个药品名称最多 ${MEDICATION_CUSTOM_NAME_MAX_LENGTH} 个字，请输入药品通用名或简称` : ''
}

function preventPointerFocus(event: ReactMouseEvent<HTMLElement>) {
  event.preventDefault()
}

interface MedicationChip {
  key: string
  label: string
  med: MedicationOption
  customName?: string
}

interface SingleSelectOption {
  value: string
  label: string
}

interface SingleSelectProps {
  value: string
  placeholder?: string
  options: SingleSelectOption[]
  ariaLabel: string
  onChange: (value: string) => void
}

function SingleSelect({ value, placeholder = '请选择', options, ariaLabel, onChange }: SingleSelectProps) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const selectedOption = options.find((option) => option.value === value)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClick)
      return () => document.removeEventListener('mousedown', handleClick)
    }
  }, [open])

  return (
    <div ref={wrapperRef} style={styles.multiSelectWrapper}>
      <button
        className="medical-profile-action"
        style={styles.singleSelectTrigger}
        onMouseDown={preventPointerFocus}
        onClick={() => setOpen((prev) => !prev)}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span
          style={{
            ...styles.singleSelectValue,
            color: selectedOption ? 'var(--color-text)' : 'var(--color-text-muted)',
          }}
        >
          {selectedOption?.label ?? placeholder}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--color-text-muted)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            flexShrink: 0,
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.2s',
            marginLeft: 8,
          }}
          aria-hidden
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div style={styles.singleSelectPanel} role="listbox" aria-label={ariaLabel}>
          {options.map((option) => {
            const checked = value === option.value
            return (
              <button
                className="medical-profile-action"
                key={option.value}
                type="button"
                role="option"
                aria-selected={checked}
                onMouseDown={preventPointerFocus}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
                style={checked ? { ...styles.dropdownOption, ...styles.dropdownOptionChecked } : styles.dropdownOption}
              >
                <span>{option.label}</span>
                {checked && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function MedicalProfileCard({ gender, currentConcern, initialData, sessionId, onSaved }: Props) {
  const setMedicalProfile = useStore((s) => s.setMedicalProfile)

  const [collapsed, setCollapsed] = useState(true)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const [menstrualStatus, setMenstrualStatus] = useState<MenstrualStatus | ''>('')
  const [noduleBiradsGrade, setNoduleBiradsGrade] = useState<NoduleBiradsGrade | ''>('')
  const [tumorType, setTumorType] = useState<TumorType | ''>('')
  const [diagnosisDuration, setDiagnosisDuration] = useState<DiagnosisDuration | ''>('')
  const [treatmentPhase, setTreatmentPhase] = useState<TreatmentPhase | ''>('')
  const [medications, setMedications] = useState<MedicationOption[]>([])
  const [medicationCustom, setMedicationCustom] = useState('')
  const [medicationCustomInput, setMedicationCustomInput] = useState('')
  const [medicationDuration, setMedicationDuration] = useState<SelectableMedicationDuration | ''>('')
  const [medicationDurations, setMedicationDurations] = useState<Record<string, SelectableMedicationDuration>>({})
  const [durationDetailOpen, setDurationDetailOpen] = useState(false)
  const [medDropdownOpen, setMedDropdownOpen] = useState(false)
  const [voiceError, setVoiceError] = useState('')
  const [medicationCustomError, setMedicationCustomError] = useState('')
  const medDropdownRef = useRef<HTMLDivElement>(null)

  const {
    toggleRecording: toggleVoice,
    isRecording: isVoiceRecording,
    isSupported: isVoiceSupported,
    partialText: voicePartialText,
  } = useVoiceRecorder({
    onTranscription: (text) => {
      const trimmed = text.trim()
      if (!trimmed) return
      commitCustomMedication(trimmed)
    },
    onError: (err) => setVoiceError(err),
  })

  const visibleFieldSet = new Set(resolveVisibleMedicalFields(currentConcern, gender))
  const showMenstrualStatus = visibleFieldSet.has('menstrualStatus')
  const showNoduleBiradsGrade = visibleFieldSet.has('noduleBiradsGrade')
  const showTumorType = visibleFieldSet.has('tumorType')
  const showDiagnosisDuration = visibleFieldSet.has('diagnosisDuration')
  const showTreatmentPhase = visibleFieldSet.has('treatmentPhase')
  const showMedications = visibleFieldSet.has('medications')
  const showMedicationDuration = visibleFieldSet.has('medicationDuration')

  useEffect(() => {
    populateFields(initialData)
  }, [initialData])

  function populateFields(profile?: MedicalProfileData | null) {
    const normalizedProfile = normalizeMedicalProfileData(profile)
    const profileMedications = normalizedProfile.medications ?? []
    setMenstrualStatus(normalizedProfile.menstrualStatus ?? '')
    setNoduleBiradsGrade(normalizedProfile.noduleBiradsGrade ?? '')
    setTumorType(normalizedProfile.tumorType ?? '')
    setDiagnosisDuration(normalizedProfile.diagnosisDuration ?? '')
    setTreatmentPhase(normalizedProfile.treatmentPhase ?? '')
    setMedications(profileMedications)
    setMedicationCustom(profileMedications.includes('other') ? (normalizedProfile.medicationCustom ?? '') : '')
    setMedicationCustomInput('')
    setMedicationCustomError('')
    const defaultDuration = SELECTABLE_MEDICATION_DURATIONS.includes(normalizedProfile.medicationDuration as any)
      ? normalizedProfile.medicationDuration as SelectableMedicationDuration
      : ''
    const rawDurationMap = normalizedProfile.medicationDurations ?? {}
    const overrideMap: Record<string, SelectableMedicationDuration> = {}
    for (const [key, duration] of Object.entries(rawDurationMap)) {
      if (SELECTABLE_MEDICATION_DURATIONS.includes(duration as any) && duration !== defaultDuration) {
        overrideMap[key] = duration as SelectableMedicationDuration
      }
    }
    setMedicationDurations(overrideMap)
    setMedicationDuration(defaultDuration)
    setDurationDetailOpen(Object.keys(overrideMap).length > 0)
  }

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (medDropdownRef.current && !medDropdownRef.current.contains(e.target as Node)) {
        setMedDropdownOpen(false)
      }
    }
    if (medDropdownOpen) {
      document.addEventListener('mousedown', handleClick)
      return () => document.removeEventListener('mousedown', handleClick)
    }
  }, [medDropdownOpen])

  function toggleMedication(med: MedicationOption) {
    setMedications((prev) => {
      if (med === 'none') {
        setMedicationCustom('')
        setMedicationCustomInput('')
        setMedicationCustomError('')
        setMedicationDuration('')
        setMedicationDurations({})
        setDurationDetailOpen(false)
        if (prev.includes(med)) return []
        return [med]
      }
      const filtered = prev.filter((m) => m !== 'none')
      if (filtered.includes(med)) {
        setMedicationDurations((durationPrev) => {
          const next = { ...durationPrev }
          delete next[med]
          return next
        })
        return filtered.filter((m) => m !== med)
      }
      return [...filtered, med]
    })
  }

  function removeMedicationChip(med: MedicationOption) {
    if (med === 'other') {
      setMedicationCustom('')
      setMedicationCustomInput('')
      setMedicationCustomError('')
    }
    setMedications((prev) => prev.filter((m) => m !== med))
    setMedicationDurations((prev) => {
      const next = { ...prev }
      delete next[med]
      return next
    })
  }

  function removeCustomMedication(name: string) {
    const nextCustomNames = activeCustomMedicationNames.filter((item) => item !== name)
    setMedicationCustom(joinMedicationCustom(nextCustomNames))
    setMedicationDurations((prev) => {
      const next = { ...prev }
      delete next[`custom:${name}`]
      return next
    })
    if (nextCustomNames.length === 0) {
      setMedications((prev) => prev.filter((m) => m !== 'other'))
    }
    setMedicationCustomError('')
  }

  function removeMedicationChipItem(chip: MedicationChip) {
    if (chip.customName) removeCustomMedication(chip.customName)
    else removeMedicationChip(chip.med)
  }

  function handleMedicationChipRemovePointerDown(event: ReactPointerEvent<HTMLElement>, chip: MedicationChip) {
    event.preventDefault()
    event.stopPropagation()
    removeMedicationChipItem(chip)
  }

  function handleMedicationChipRemoveKeyDown(event: ReactKeyboardEvent<HTMLElement>, chip: MedicationChip) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    event.stopPropagation()
    removeMedicationChipItem(chip)
  }

  function commitCustomMedication(value = medicationCustomInput): boolean {
    const customNames = splitMedicationCustom(value)
    if (customNames.length === 0) return true
    const validationError = getMedicationCustomValidationError(customNames)
    if (validationError) {
      setMedicationCustomError(validationError)
      return false
    }
    setMedicationCustom((prev) => {
      const previousNames = medications.includes('other') ? splitMedicationCustom(prev) : []
      return joinMedicationCustom([...previousNames, ...customNames])
    })
    setMedications((prev) => {
      const cleared = prev.filter((m) => m !== 'none')
      return cleared.includes('other') ? cleared : [...cleared, 'other']
    })
    setMedicationCustomInput('')
    setMedicationCustomError('')
    return true
  }

  function handleCustomChange(val: string) {
    const normalizedLength = getTextLength(normalizeMedicationCustomName(val))
    if (normalizedLength > MEDICATION_CUSTOM_NAME_MAX_LENGTH) {
      setMedicationCustomInput(sliceText(val, MEDICATION_CUSTOM_NAME_MAX_LENGTH))
      setMedicationCustomError(`单个药品名称最多 ${MEDICATION_CUSTOM_NAME_MAX_LENGTH} 个字，请输入药品通用名或简称`)
      return
    }
    setMedicationCustomInput(val)
    setMedicationCustomError('')
  }

  function handleMedicationPanelDone() {
    if (!commitCustomMedication()) return
    setMedDropdownOpen(false)
  }

  const COMMON_MEDS: MedicationOption[] = ['tamoxifen', 'letrozole', 'anastrozole', 'exemestane', 'fulvestrant']

  const customMedicationNames = splitMedicationCustom(medicationCustom)
  const activeCustomMedicationNames = medications.includes('other') ? customMedicationNames : []
  const medicationProfileDraft: MedicalProfileData = normalizeMedicalProfileData({
    medications,
    medicationCustom,
    medicationDuration: medications.includes('none') ? 'not_required' : medicationDuration || undefined,
    medicationDurations,
  })
  const medicationItems = resolveMedicationItems(medications, medicationCustom)
  const medicationDurationSummary = formatMedicationDurationDetails(medicationProfileDraft)
  const medicationChips: MedicationChip[] = medications.flatMap((m): MedicationChip[] => {
    if (m !== 'other') return [{ key: m, label: MEDICATION_LABELS[m], med: m }]
    const customNames = activeCustomMedicationNames.length ? activeCustomMedicationNames : [MEDICATION_LABELS[m]]
    return customNames.map((name) => ({
      key: `other:${name}`,
      label: name,
      med: m,
      customName: activeCustomMedicationNames.length ? name : undefined,
    }))
  })
  const hasMedicationSelection = medicationChips.length > 0
  const selectedMedicationCount = medicationItems.length

  const medSummary = formatMedicationNames(medicationProfileDraft)

  function buildSummary(): string {
    const parts: string[] = []
    if (showNoduleBiradsGrade && noduleBiradsGrade) parts.push(NODULE_BIRADS_GRADE_LABELS[noduleBiradsGrade])
    if (showTumorType && tumorType) parts.push(TUMOR_TYPE_LABELS[tumorType])
    if (showDiagnosisDuration && diagnosisDuration) parts.push(DIAGNOSIS_DURATION_LABELS[diagnosisDuration])
    if (showTreatmentPhase && treatmentPhase) parts.push(TREATMENT_PHASE_LABELS[treatmentPhase])
    if (showMenstrualStatus && menstrualStatus) parts.push(MENSTRUAL_STATUS_LABELS[menstrualStatus])
    if (showMedications && medSummary) parts.push(medSummary)
    if (showMedicationDuration && medicationDurationSummary !== '未填写') parts.push(medicationDurationSummary)
    return parts.join(' · ')
  }

  function setMedicationDurationOverride(key: string, duration: string) {
    setMedicationDurations((prev) => {
      const next = { ...prev }
      if (!duration) delete next[key]
      else next[key] = duration as SelectableMedicationDuration
      return next
    })
  }

  async function handleSave() {
    setError('')
    const pendingCustomNames = showMedications ? splitMedicationCustom(medicationCustomInput) : []
    const customValidationError = showMedications
      ? getMedicationCustomValidationError([...activeCustomMedicationNames, ...pendingCustomNames])
      : ''
    if (customValidationError) {
      setMedicationCustomError(customValidationError)
      setMedDropdownOpen(true)
      return
    }
    setMedicationCustomError('')
    setSaving(true)
    try {
      const profileData: MedicalProfileData = {}
      if (showMenstrualStatus && menstrualStatus) profileData.menstrualStatus = menstrualStatus
      if (showNoduleBiradsGrade && noduleBiradsGrade) profileData.noduleBiradsGrade = noduleBiradsGrade
      if (showTumorType && tumorType) profileData.tumorType = tumorType
      if (showDiagnosisDuration && diagnosisDuration) profileData.diagnosisDuration = diagnosisDuration
      if (showTreatmentPhase && treatmentPhase) profileData.treatmentPhase = treatmentPhase
      if (showMedications) {
        const finalCustom = joinMedicationCustom([...activeCustomMedicationNames, ...pendingCustomNames])
        const finalMedications = finalCustom
          ? (() => {
              const cleared = medications.filter((m) => m !== 'none')
              return cleared.includes('other') ? cleared : [...cleared, 'other' as const]
            })()
          : medications
        profileData.medications = finalMedications
        profileData.medicationCustom = finalMedications.includes('other') ? finalCustom : ''
        if (finalMedications.includes('none')) {
          profileData.medicationDuration = 'not_required'
          profileData.medicationDurations = {}
        } else {
          const finalMedicationItems = resolveMedicationItems(finalMedications, profileData.medicationCustom)
          const finalDurationMap: Record<string, SelectableMedicationDuration> = {}
          for (const item of finalMedicationItems) {
            const overrideDuration = medicationDurations[item.key]
            if (overrideDuration && overrideDuration !== medicationDuration) {
              finalDurationMap[item.key] = overrideDuration
            }
          }
          if (finalMedicationItems.length > 0 && medicationDuration) profileData.medicationDuration = medicationDuration
          profileData.medicationDurations = finalDurationMap
        }
      }

      const res = await api.post<ApiResponse<MedicalRecord>>('/medical', {
        profileData,
        ...(sessionId ? { sessionId } : {}),
      })
      if (res.data) {
        setMedicalProfile(res.data.profileData)
        populateFields(res.data.profileData)
        onSaved?.(res.data.profileData)
      }
      setEditing(false)
      setCollapsed(true)
    } catch (err: any) {
      setError(err.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  function handleCancel() {
    populateFields(initialData)
    setEditing(false)
    setCollapsed(true)
    setMedDropdownOpen(false)
    setError('')
    setMedicationCustomError('')
  }

  function handleEdit() {
    setEditing(true)
    setCollapsed(false)
  }

  const summary = buildSummary()

  return (
    <div style={styles.card}>
      {/* Header */}
      <div style={styles.cardHeader}>
        <div style={styles.cardTitleWrap}>
          <span style={styles.cardIcon} aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 3h9l3 3v15H6z" />
              <path d="M14 3v4h4" />
              <path d="M9 13h6" />
              <path d="M12 10v6" />
            </svg>
          </span>
          <span style={styles.cardTitle}>病历档案</span>
        </div>
        <div style={styles.headerActions}>
          {!editing && (
            <button className="medical-profile-action" style={styles.editBtn} onMouseDown={preventPointerFocus} onClick={handleEdit}>编辑</button>
          )}
          <button
            className="medical-profile-action"
            style={styles.chevronBtn}
            onMouseDown={preventPointerFocus}
            onClick={() => { if (editing) handleCancel(); else setCollapsed(!collapsed) }}
          >
            <svg
              width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke="var(--color-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              style={{ transform: collapsed ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.2s' }}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>
      </div>

      {/* Collapsed summary */}
      {collapsed && (
        <div style={styles.summaryLine}>
          {summary || '尚未填写病历信息'}
        </div>
      )}

      {/* Expanded read-only view */}
      {!collapsed && !editing && (
        <div style={styles.readonlyFields}>
          {showMenstrualStatus && menstrualStatus && (
            <div style={styles.fieldRow}>
              <span style={styles.fieldLabel}>月经状态</span>
              <span style={styles.fieldValue}>{MENSTRUAL_STATUS_LABELS[menstrualStatus]}</span>
            </div>
          )}
          {showNoduleBiradsGrade && noduleBiradsGrade && (
            <div style={styles.fieldRow}>
              <span style={styles.fieldLabel}>乳腺检查分型</span>
              <span style={styles.fieldValue}>{NODULE_BIRADS_GRADE_LABELS[noduleBiradsGrade]}</span>
            </div>
          )}
          {showTumorType && tumorType && (
            <div style={styles.fieldRow}>
              <span style={styles.fieldLabel}>肿瘤分型</span>
              <span style={styles.fieldValue}>{TUMOR_TYPE_LABELS[tumorType]}</span>
            </div>
          )}
          {showDiagnosisDuration && diagnosisDuration && (
            <div style={styles.fieldRow}>
              <span style={styles.fieldLabel}>确诊时长</span>
              <span style={styles.fieldValue}>{DIAGNOSIS_DURATION_LABELS[diagnosisDuration]}</span>
            </div>
          )}
          {showTreatmentPhase && treatmentPhase && (
            <div style={styles.fieldRow}>
              <span style={styles.fieldLabel}>治疗阶段</span>
              <span style={styles.fieldValue}>{TREATMENT_PHASE_LABELS[treatmentPhase]}</span>
            </div>
          )}
          {showMedications && medSummary && (
            <div style={styles.fieldRow}>
              <span style={styles.fieldLabel}>用药情况</span>
              <span style={styles.fieldValue}>{medSummary}</span>
            </div>
          )}
          {showMedicationDuration && medicationDurationSummary !== '未填写' && (
            <div style={styles.fieldRow}>
              <span style={styles.fieldLabel}>用药时长</span>
              <span style={styles.fieldValue}>{medicationDurationSummary}</span>
            </div>
          )}
          {!summary && (
            <div style={{ fontSize: 13, color: 'var(--color-text-muted)', padding: '4px 0' }}>
              暂无病历信息，点击"编辑"开始填写
            </div>
          )}
        </div>
      )}

      {/* Editing form */}
      {!collapsed && editing && (
        <div style={styles.editForm}>
          {showNoduleBiradsGrade && (
            <div>
              <label style={styles.label}>乳腺检查分型</label>
              <SingleSelect
                value={noduleBiradsGrade}
                ariaLabel="乳腺检查分型"
                options={NODULE_BIRADS_GRADES.map((grade) => ({ value: grade, label: NODULE_BIRADS_GRADE_LABELS[grade] }))}
                onChange={(value) => setNoduleBiradsGrade(value as NoduleBiradsGrade)}
              />
            </div>
          )}

          {showMenstrualStatus && (
            <div>
              <label style={styles.label}>月经状态</label>
              <SingleSelect
                value={menstrualStatus}
                ariaLabel="月经状态"
                options={MENSTRUAL_STATUSES.map((s) => ({ value: s, label: MENSTRUAL_STATUS_LABELS[s] }))}
                onChange={(value) => setMenstrualStatus(value as MenstrualStatus)}
              />
            </div>
          )}

          {showTumorType && (
            <div>
              <label style={styles.label}>肿瘤分型</label>
              <SingleSelect
                value={tumorType}
                ariaLabel="肿瘤分型"
                options={TUMOR_TYPES.map((t) => ({ value: t, label: TUMOR_TYPE_LABELS[t] }))}
                onChange={(value) => setTumorType(value as TumorType)}
              />
            </div>
          )}

          {showDiagnosisDuration && (
            <div>
              <label style={styles.label}>确诊时长</label>
              <SingleSelect
                value={diagnosisDuration}
                ariaLabel="确诊时长"
                options={DIAGNOSIS_DURATIONS.map((d) => ({ value: d, label: DIAGNOSIS_DURATION_LABELS[d] }))}
                onChange={(value) => setDiagnosisDuration(value as DiagnosisDuration)}
              />
            </div>
          )}

          {showTreatmentPhase && (
            <div>
              <label style={styles.label}>治疗阶段</label>
              <SingleSelect
                value={treatmentPhase}
                ariaLabel="治疗阶段"
                options={TREATMENT_PHASES.map((p) => ({ value: p, label: TREATMENT_PHASE_LABELS[p] }))}
                onChange={(value) => setTreatmentPhase(value as TreatmentPhase)}
              />
            </div>
          )}

          {showMedications && (
            <div>
              <label style={styles.label}>用药情况（可多选）</label>
              <div ref={medDropdownRef} style={styles.multiSelectWrapper}>
                <button className="medical-profile-action" style={styles.multiSelectTrigger} onMouseDown={preventPointerFocus} onClick={() => setMedDropdownOpen(!medDropdownOpen)} type="button">
                  {!hasMedicationSelection ? (
                    <span style={{ color: 'var(--color-text-muted)', flex: 1, textAlign: 'left' }}>请选择用药情况</span>
                  ) : (
                    <>
                      {selectedMedicationCount > 0 && <span style={styles.triggerCount}>已选 {selectedMedicationCount} 种</span>}
                      <div style={styles.triggerChipRow}>
                        {medicationChips.map((chip) => (
                          <span key={chip.key} style={styles.triggerChip}>
                            <span style={styles.triggerChipText}>
                              {chip.label}
                            </span>
                            <span
                              role="button"
                              tabIndex={0}
                              className="medical-profile-action"
                              onPointerDown={(e) => handleMedicationChipRemovePointerDown(e, chip)}
                              onKeyDown={(e) => handleMedicationChipRemoveKeyDown(e, chip)}
                              onClick={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                              }}
                              style={styles.triggerChipX}
                              aria-label="删除"
                            >×</span>
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: medDropdownOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', marginLeft: 8 }}>
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {medDropdownOpen && (
                  <div style={styles.medPanel}>
                    <div style={styles.medPanelLabel}>常见药品</div>
                    <div style={styles.pillGrid}>
                      {COMMON_MEDS.map((m) => {
                        const checked = medications.includes(m)
                        return (
                          <button
                            className="medical-profile-action medical-profile-pill"
                            key={m}
                            type="button"
                            aria-pressed={checked}
                            onMouseDown={preventPointerFocus}
                            onClick={() => toggleMedication(m)}
                            style={checked ? { ...styles.pill, ...styles.pillChecked } : styles.pill}
                          >
                            <span>{MEDICATION_LABELS[m]}</span>
                            {checked && (
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 4 }}>
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            )}
                          </button>
                        )
                      })}
                    </div>

                    <div style={styles.searchRow}>
                      <input
                        style={styles.searchInput}
                        placeholder={isVoiceRecording ? '正在聆听...' : '输入其他药品名后点添加...'}
                        value={isVoiceRecording && voicePartialText ? voicePartialText : medicationCustomInput}
                        onChange={(e) => handleCustomChange(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            commitCustomMedication()
                          }
                        }}
                        disabled={isVoiceRecording}
                      />
                      <button
                        className="medical-profile-action"
                        type="button"
                        onMouseDown={preventPointerFocus}
                        onClick={() => commitCustomMedication()}
                        disabled={isVoiceRecording || !medicationCustomInput.trim()}
                        style={{
                          ...styles.addCustomMedBtn,
                          opacity: isVoiceRecording || !medicationCustomInput.trim() ? 0.45 : 1,
                          cursor: isVoiceRecording || !medicationCustomInput.trim() ? 'not-allowed' : 'pointer',
                        }}
                      >添加</button>
                      {isVoiceSupported && (
                        <button
                          className="medical-profile-action"
                          type="button"
                          onMouseDown={preventPointerFocus}
                          onClick={() => { setVoiceError(''); toggleVoice() }}
                          style={isVoiceRecording ? { ...styles.micBtn, ...styles.micBtnActive } : styles.micBtn}
                          aria-label={isVoiceRecording ? '停止录音' : '语音输入'}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                            <line x1="12" y1="19" x2="12" y2="23" />
                            <line x1="8" y1="23" x2="16" y2="23" />
                          </svg>
                        </button>
                      )}
                    </div>

                    {medicationCustomError && <p style={styles.medicationCustomError}>{medicationCustomError}</p>}

                    <div style={styles.altRow}>
                      <button
                        className="medical-profile-action medical-profile-alt"
                        type="button"
                        aria-pressed={medications.includes('none')}
                        onMouseDown={preventPointerFocus}
                        onClick={() => toggleMedication('none')}
                        style={medications.includes('none') ? { ...styles.altBtn, ...styles.altBtnActive } : styles.altBtn}
                      >暂未用药</button>
                    </div>

                    {voiceError && <p style={{ ...styles.error, marginTop: 6 }}>{voiceError}</p>}

                    <button
                      className="medical-profile-action"
                      type="button"
                      onMouseDown={preventPointerFocus}
                      onClick={handleMedicationPanelDone}
                      style={styles.panelDoneBtn}
                    >完成</button>
                  </div>
                )}
              </div>
            </div>
          )}

          {showMedicationDuration && medications.length > 0 && (
            <div>
              <label style={styles.label}>{medications.includes('none') ? '用药时长' : '默认用药时长'}</label>
              {medications.includes('none') ? (
                <div style={styles.readonlyDurationBox}>无需填写</div>
              ) : (
                <>
                  <SingleSelect
                    value={medicationDuration}
                    ariaLabel="默认用药时长"
                    options={SELECTABLE_MEDICATION_DURATIONS.map((d) => ({ value: d, label: MEDICATION_DURATION_LABELS[d] }))}
                    onChange={(value) => setMedicationDuration(value as SelectableMedicationDuration)}
                  />
                  {medicationItems.length > 1 && (
                    <button
                      className="medical-profile-action"
                      type="button"
                      onMouseDown={preventPointerFocus}
                      onClick={() => setDurationDetailOpen((prev) => !prev)}
                      style={styles.durationDetailToggle}
                    >
                      <span>各药品用药时长不同？单独设置</span>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: durationDetailOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </button>
                  )}
                  {durationDetailOpen && medicationItems.length > 0 && (
                    <div style={styles.durationDetailPanel}>
                      <div style={styles.durationDetailTitle}>各药品用药时长</div>
                      {medicationItems.map((item) => (
                        <div key={item.key} style={styles.durationDetailRow}>
                          <span style={styles.durationDrugName}>{item.label}</span>
                          <div style={styles.durationSelectCell}>
                            <SingleSelect
                              value={medicationDurations[item.key] ?? ''}
                              ariaLabel={`${item.label}用药时长`}
                              options={[
                                {
                                  value: '',
                                  label: medicationDuration
                                    ? `使用默认：${MEDICATION_DURATION_LABELS[medicationDuration]}`
                                    : '未单独设置',
                                },
                                ...SELECTABLE_MEDICATION_DURATIONS.map((d) => ({
                                  value: d,
                                  label: MEDICATION_DURATION_LABELS[d],
                                })),
                              ]}
                              onChange={(value) => setMedicationDurationOverride(item.key, value)}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {error && <p style={styles.error}>{error}</p>}

          <div style={styles.btnRow}>
            <button className="medical-profile-action" style={styles.cancelBtn} onMouseDown={preventPointerFocus} onClick={handleCancel}>取消</button>
            <button className="medical-profile-action" style={{ ...styles.saveBtn, opacity: saving ? 0.5 : 1 }} onMouseDown={preventPointerFocus} onClick={handleSave} disabled={saving}>
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: 'rgba(255,255,255,0.78)',
    border: '1px solid rgba(216, 180, 160, 0.14)',
    borderRadius: 20,
    padding: '16px 16px',
    marginBottom: 6,
    boxShadow: '0 12px 30px rgba(188, 116, 88, 0.08)',
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  cardTitleWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    minWidth: 0,
  },
  cardIcon: {
    width: 46,
    height: 46,
    borderRadius: 16,
    color: 'var(--color-primary)',
    background: 'var(--color-primary-bg)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: 700,
    color: 'var(--color-text)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  headerActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  editBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--color-primary)',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    padding: '2px 4px',
  },
  chevronBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 4,
    display: 'flex',
    alignItems: 'center',
  },
  summaryLine: {
    fontSize: 13,
    color: 'var(--color-text-muted)',
    marginTop: 12,
    lineHeight: 1.5,
  },
  readonlyFields: {
    marginTop: 12,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
  },
  fieldRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
  },
  fieldLabel: {
    fontSize: 13,
    color: 'var(--color-text-muted)',
    flexShrink: 0,
  },
  fieldValue: {
    fontSize: 13,
    color: 'var(--color-text)',
    fontWeight: 500,
    textAlign: 'right' as const,
  },
  editForm: {
    marginTop: 14,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 16,
  },
  label: {
    display: 'block',
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--color-text-secondary)',
    marginBottom: 6,
  },
  singleSelectTrigger: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    minHeight: 48,
    borderRadius: 12,
    border: '1px solid rgba(216, 180, 160, 0.24)',
    padding: '6px 14px',
    fontSize: 15,
    outline: 'none',
    background: 'rgba(255, 249, 245, 0.86)',
    cursor: 'pointer',
    boxSizing: 'border-box' as const,
  },
  singleSelectValue: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    textAlign: 'left' as const,
  },
  singleSelectPanel: {
    position: 'absolute' as const,
    top: 56,
    left: 0,
    right: 0,
    background: 'rgba(255,255,255,0.98)',
    border: '1px solid rgba(216, 180, 160, 0.18)',
    borderRadius: 14,
    padding: 8,
    zIndex: 10,
    boxShadow: '0 8px 24px rgba(0,0,0,0.08)',
  },
  dropdownOption: {
    width: '100%',
    minHeight: 42,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    padding: '0 12px',
    border: 'none',
    borderRadius: 10,
    background: 'transparent',
    color: 'var(--color-text)',
    fontSize: 14,
    textAlign: 'left' as const,
    cursor: 'pointer',
  },
  dropdownOptionChecked: {
    color: 'var(--color-primary)',
    background: 'rgba(245, 140, 58, 0.06)',
  },
  input: {
    display: 'block',
    width: '100%',
    height: 44,
    borderRadius: 10,
    border: '1px solid rgba(216, 180, 160, 0.24)',
    padding: '0 12px',
    fontSize: 14,
    outline: 'none',
    background: 'rgba(255, 249, 245, 0.86)',
    color: 'var(--color-text)',
    boxSizing: 'border-box' as const,
  },
  multiSelectWrapper: {
    position: 'relative' as const,
  },
  multiSelectTrigger: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    minHeight: 44,
    borderRadius: 10,
    border: '1px solid rgba(216, 180, 160, 0.24)',
    padding: '6px 12px',
    fontSize: 14,
    outline: 'none',
    background: 'rgba(255, 249, 245, 0.86)',
    cursor: 'pointer',
    boxSizing: 'border-box' as const,
  },
  triggerCount: {
    fontSize: 13,
    color: 'var(--color-text)',
    fontWeight: 500,
    flexShrink: 0,
  },
  triggerChipRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 6,
    flex: 1,
    alignItems: 'center',
    maxHeight: 58,
    overflowY: 'auto' as const,
    paddingRight: 2,
  },
  triggerChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    height: 24,
    padding: '0 6px 0 10px',
    borderRadius: 12,
    background: 'var(--color-primary-bg)',
    color: 'var(--color-primary)',
    fontSize: 12,
    maxWidth: 140,
  },
  triggerChipText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  triggerChipX: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 16,
    height: 16,
    borderRadius: 8,
    color: 'var(--color-primary)',
    cursor: 'pointer',
    fontSize: 14,
    lineHeight: 1,
    opacity: 0.75,
  },
  medPanel: {
    position: 'absolute' as const,
    top: 'calc(100% + 8px)',
    left: 0,
    right: 0,
    background: 'rgba(255,255,255,0.98)',
    border: '1px solid rgba(216, 180, 160, 0.18)',
    borderRadius: 14,
    padding: 14,
    zIndex: 10,
    boxShadow: '0 8px 24px rgba(0,0,0,0.08)',
  },
  medPanelLabel: {
    fontSize: 12,
    color: 'var(--color-text-muted)',
    marginBottom: 10,
  },
  pillGrid: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 8,
  },
  pill: {
    display: 'inline-flex',
    alignItems: 'center',
    height: 34,
    padding: '0 14px',
    borderRadius: 17,
    border: '1px solid rgba(216, 180, 160, 0.24)',
    background: 'rgba(255, 249, 245, 0.86)',
    color: 'var(--color-text)',
    fontSize: 13,
    cursor: 'pointer',
    transition: 'all 0.15s',
  },
  pillChecked: {
    borderColor: 'var(--color-primary)',
    color: 'var(--color-primary)',
    background: 'rgba(245, 140, 58, 0.06)',
  },
  searchRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
    flexWrap: 'wrap',
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    height: 40,
    borderRadius: 20,
    border: '1px solid rgba(216, 180, 160, 0.24)',
    padding: '0 14px',
    fontSize: 13,
    outline: 'none',
    background: 'rgba(255, 249, 245, 0.86)',
    color: 'var(--color-text)',
    boxSizing: 'border-box' as const,
  },
  medicationCustomError: {
    color: 'var(--color-error)',
    fontSize: 12,
    lineHeight: 1.4,
    margin: '6px 2px 0',
  },
  addCustomMedBtn: {
    height: 36,
    padding: '0 12px',
    borderRadius: 18,
    border: 'none',
    background: 'var(--color-primary)',
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    flexShrink: 0,
  },
  micBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    border: 'none',
    background: 'var(--color-primary)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    flexShrink: 0,
  },
  micBtnActive: {
    animation: 'pulse 1.2s ease-in-out infinite',
    boxShadow: '0 0 0 4px rgba(245, 140, 58, 0.2)',
  },
  altRow: {
    display: 'flex',
    gap: 8,
    marginTop: 10,
  },
  altBtn: {
    flex: 1,
    height: 32,
    borderRadius: 999,
    border: '1px solid rgba(216, 180, 160, 0.24)',
    background: 'rgba(255,255,255,0.6)',
    color: 'var(--color-text-muted)',
    fontSize: 12,
    cursor: 'pointer',
  },
  altBtnActive: {
    borderColor: 'var(--color-primary)',
    color: 'var(--color-primary)',
    background: 'rgba(245, 140, 58, 0.06)',
  },
  readonlyDurationBox: {
    minHeight: 44,
    borderRadius: 10,
    border: '1px solid rgba(216, 180, 160, 0.24)',
    padding: '0 12px',
    display: 'flex',
    alignItems: 'center',
    color: 'var(--color-text-muted)',
    fontSize: 14,
    background: 'rgba(255, 249, 245, 0.86)',
    boxSizing: 'border-box' as const,
  },
  durationDetailToggle: {
    width: '100%',
    minHeight: 38,
    marginTop: 8,
    border: 'none',
    borderTop: '1px solid rgba(245, 140, 58, 0.18)',
    background: 'transparent',
    color: 'var(--color-primary)',
    fontSize: 13,
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    cursor: 'pointer',
    padding: '8px 2px 0',
  },
  durationDetailPanel: {
    marginTop: 8,
    border: '1px solid rgba(245, 140, 58, 0.22)',
    borderRadius: 12,
    padding: 12,
    background: 'rgba(245, 140, 58, 0.04)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
  },
  durationDetailTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--color-text)',
  },
  durationDetailRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  },
  durationDrugName: {
    width: 82,
    flexShrink: 0,
    fontSize: 13,
    color: 'var(--color-text)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  durationSelectCell: {
    flex: 1,
    minWidth: 180,
  },
  panelDoneBtn: {
    width: '100%',
    height: 42,
    borderRadius: 21,
    border: 'none',
    background: 'var(--color-primary)',
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: 14,
  },
  btnRow: {
    display: 'flex',
    gap: 10,
    marginTop: 4,
  },
  cancelBtn: {
    flex: 1,
    height: 42,
    borderRadius: 999,
    border: '1px solid rgba(216, 180, 160, 0.24)',
    background: 'rgba(255,255,255,0.68)',
    color: 'var(--color-text)',
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
  },
  saveBtn: {
    flex: 1,
    height: 42,
    borderRadius: 999,
    border: 'none',
    background: 'linear-gradient(135deg, #D4876C 0%, #E4A084 100%)',
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'opacity 0.2s',
  },
  error: {
    color: 'var(--color-error)',
    fontSize: 12,
    textAlign: 'center' as const,
    margin: 0,
  },
}
