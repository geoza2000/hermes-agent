import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@hermes/plugin-sdk'

import { GM_FAMILIES, GM_PROGRAMS, type Instrument } from './gm'
import { useSongText } from './i18n'

const DRUMS = 'drums'

interface InstrumentPickerProps {
  value: Instrument
  label: string
  disabled?: boolean
  onChange: (instrument: Instrument) => void
}

export function InstrumentPicker({ value, label, disabled, onChange }: InstrumentPickerProps) {
  const t = useSongText()

  return (
    <Select
      disabled={disabled}
      onValueChange={next => onChange(next === DRUMS ? { program: 0, drums: true } : { program: Number(next), drums: false })}
      value={value.drums ? DRUMS : String(value.program)}
    >
      <SelectTrigger aria-label={label} className="h-7 w-full min-w-0 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-80">
        <SelectItem value={DRUMS}>{t('drumKit')}</SelectItem>
        {GM_FAMILIES.map((family, group) => (
          <div key={family} role="group">
            <div className="px-2 pt-2 pb-1 text-[0.625rem] font-semibold tracking-wide text-(--ui-text-tertiary) uppercase">
              {family}
            </div>
            {GM_PROGRAMS.slice(group * 8, group * 8 + 8).map((name, index) => (
              <SelectItem key={name} value={String(group * 8 + index)}>
                {name}
              </SelectItem>
            ))}
          </div>
        ))}
      </SelectContent>
    </Select>
  )
}
