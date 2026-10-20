import type { CheckInEditableFormProps } from '../lib/a2ui/EditableForm.js'
import type { CheckInRecord } from '@health-agent/shared'

type CheckInRecordEditableFormProps = Pick<
  CheckInEditableFormProps,
  'schema' | 'values' | 'attachments' | 'note' | 'tags' | 'statusLabel' | 'readOnly'
>

export interface CheckInRecordEditState {
  recordId: string
  values: CheckInRecord['valuesJson']
  note: string
  tags: string[]
}

function noteFromRecord(record: CheckInRecord): string {
  const noteBlock = record.renderedA2uiSchema.blocks.find((block) => block.type === 'note')
  if (noteBlock?.type === 'note') return noteBlock.text
  return ''
}

export function getCheckInRecordEditableFormProps(record: CheckInRecord): CheckInRecordEditableFormProps {
  return {
    schema: record.schemaSnapshot,
    values: record.valuesJson,
    attachments: record.attachmentsJson,
    note: noteFromRecord(record),
    tags: record.tags,
    statusLabel: '已保存',
    readOnly: true,
  }
}

export function createCheckInRecordEditState(record: CheckInRecord): CheckInRecordEditState {
  return {
    recordId: record.id,
    values: { ...record.valuesJson },
    note: noteFromRecord(record),
    tags: [...record.tags],
  }
}

export function applyUpdatedCheckInRecord(records: CheckInRecord[], updated: CheckInRecord): CheckInRecord[] {
  return records.map((record) => (record.id === updated.id ? updated : record))
}
