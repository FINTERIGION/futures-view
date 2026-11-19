import { useTranslation } from 'react-i18next'
import { Modal } from '../components/Modal'
import { formatCombo, SHORTCUTS } from './useHotkeys'

export function ShortcutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation()

  return (
    <Modal open={open} onClose={onClose} title={t('workspace.shortcuts')} size="sm">
      <div className="shortcut-list">
        {SHORTCUTS.map((s) => (
          <div className="shortcut-row" key={s.combo}>
            <span>{t(s.key)}</span>
            <span className="shortcut-keys">
              {formatCombo(s.combo).map((k) => (
                <kbd className="kbd" key={k}>
                  {k}
                </kbd>
              ))}
            </span>
          </div>
        ))}
      </div>
    </Modal>
  )
}
