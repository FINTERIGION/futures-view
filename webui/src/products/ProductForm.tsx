import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { EChart } from '../components/EChart'
import { MONTHS, type CommissionMode, type ProductFormHandle } from './useProductForm'

export function ProductFormFields({ f }: { f: ProductFormHandle }) {
  const { t } = useTranslation()
  const idPrefix = useId()

  return (
    <>
      {f.formError && <div className="hint-banner warning">{f.formError}</div>}

      {!f.isEdit && (
        <div className="field">
          <label htmlFor={`${idPrefix}-code`}>{t('products.code')}</label>
          <input
            id={`${idPrefix}-code`}
            value={f.form.code}
            onChange={(e) => f.set('code', e.target.value.toUpperCase())}
            placeholder="e.g. AP"
          />
        </div>
      )}

      <div className="form-grid">
        <div className="field">
          <label htmlFor={`${idPrefix}-exchange`}>{t('products.exchange')}</label>
          <select
            id={`${idPrefix}-exchange`}
            value={f.form.exchange}
            onChange={(e) => f.set('exchange', e.target.value)}
          >
            {f.exchanges.map((ex) => (
              <option key={ex} value={ex}>
                {ex}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-start-year`}>{t('products.startYear')}</label>
          <input
            id={`${idPrefix}-start-year`}
            type="number"
            value={f.form.start_year}
            onChange={(e) => f.set('start_year', e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-name`}>{t('products.name')}</label>
          <input id={`${idPrefix}-name`} value={f.form.name} onChange={(e) => f.set('name', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-name-zh`}>{t('products.nameZh')}</label>
          <input id={`${idPrefix}-name-zh`} value={f.form.name_zh} onChange={(e) => f.set('name_zh', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-multiplier`}>{t('products.multiplier')}</label>
          <input
            id={`${idPrefix}-multiplier`}
            type="number"
            value={f.form.multiplier}
            onChange={(e) => f.set('multiplier', e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-tick-size`}>{t('products.tickSize')}</label>
          <input
            id={`${idPrefix}-tick-size`}
            type="number"
            step="any"
            value={f.form.tick_size}
            onChange={(e) => f.set('tick_size', e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-margin-rate`}>{t('products.marginRate')}</label>
          <div className="input-group">
            <input
              id={`${idPrefix}-margin-rate`}
              type="number"
              step="any"
              min="0"
              max="100"
              value={f.form.margin_rate}
              onChange={(e) => f.set('margin_rate', e.target.value)}
            />
            <span className="input-unit">%</span>
          </div>
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-commission`}>{t('products.commissionMode')}</label>
          <div className="input-group">
            <input
              id={`${idPrefix}-commission`}
              type="number"
              step="0.1"
              value={f.form.commission_value}
              onChange={(e) => f.set('commission_value', e.target.value)}
            />
            <select
              aria-label={t('products.commissionMode')}
              value={f.form.commission_mode}
              onChange={(e) => f.set('commission_mode', e.target.value as CommissionMode)}
            >
              <option value="rate">{t('products.commissionModeRate')}</option>
              <option value="per_lot">{t('products.commissionModePerLot')}</option>
            </select>
          </div>
        </div>
        <div className="field field-wide">
          <label>{t('products.mainMonths')}</label>
          <div className="month-picker">
            {MONTHS.map((m) => (
              <label key={m} className={`month-chip${f.form.main_months.includes(m) ? ' active' : ''}`}>
                <input type="checkbox" checked={f.form.main_months.includes(m)} onChange={() => f.toggleMonth(m)} />
                <span>{m}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-roll-lead`}>{t('products.rollLeadMonths')}</label>
          <input
            id={`${idPrefix}-roll-lead`}
            type="number"
            value={f.form.roll_lead_months}
            onChange={(e) => f.set('roll_lead_months', e.target.value)}
          />
        </div>
      </div>

      {f.isEdit && (
        <div style={{ marginTop: 20 }}>
          <h3 style={{ marginBottom: 10 }}>{t('products.priceChart')}</h3>
          {f.chartOption ? (
            <EChart option={f.chartOption} height={360} />
          ) : (
            <div className="empty-state">
              {f.barsLoading ? t('common.loading') : t('products.noData')}
            </div>
          )}
        </div>
      )}
    </>
  )
}
