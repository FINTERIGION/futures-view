import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RunDetail, TradeLog } from '../api/types'
import { lineSeriesOption } from '../charts/builders'
import { Card } from '../components/Card'
import { EChart } from '../components/EChart'
import { Icon } from '../components/Icon'
import { MetricStats } from '../components/MetricStats'
import { formatMetricValue, metricTone } from '../components/metricFormat'
import { Table } from '../components/Table'
import type { Column } from '../components/Table'
import { Tabs } from '../components/Tabs'
import { useWorkspace } from '../shell/workspaceStore'
import { useIsDarkMode } from '../theme/useIsDarkMode'

interface SymbolBreakdownRow {
  symbol: string
  stats: Record<string, number>
}

export function ResultTables({ run }: { run: RunDetail }) {
  const { t } = useTranslation()
  const dark = useIsDarkMode()
  const { chartSymbol, setChartSymbol, focusChartRange } = useWorkspace()
  const [tab, setTab] = useState('trades')
  const [tradeSymbolFilter, setTradeSymbolFilter] = useState<string>('')
  const [focusedTradeId, setFocusedTradeId] = useState<number | null>(null)

  const equityOption = useMemo(
    () =>
      lineSeriesOption(
        dark,
        run.equity_records.map((r) => r.date),
        [{ name: t('backtest.equityCurve'), values: run.equity_records.map((r) => r.equity) }],
        { money: true, area: true },
      ),
    [dark, run.equity_records, t],
  )

  const tabs = [
    { key: 'trades', label: t('backtest.tradeLog') },
    { key: 'symbol', label: t('backtest.bySymbol') },
    { key: 'exit', label: t('backtest.byExitReason') },
  ]

  const filteredTrades = useMemo(
    () => (tradeSymbolFilter ? run.trade_logs.filter((r) => r.symbol === tradeSymbolFilter) : run.trade_logs),
    [run.trade_logs, tradeSymbolFilter],
  )

  const tradeColumns: Column<TradeLog>[] = [
    { key: 'symbol', header: t('common.symbols'), render: (r) => <strong className="alert-strategy">{r.symbol}</strong> },
    { key: 'direction', header: t('backtest.direction'), render: (r) => r.direction },
    { key: 'open_date', header: t('common.start'), render: (r) => r.open_date },
    { key: 'close_date', header: t('common.end'), render: (r) => r.close_date ?? '—' },
    { key: 'size', header: t('backtest.size'), numeric: true, render: (r) => r.size },
    {
      key: 'net_pnl',
      header: t('backtest.netPnl'),
      numeric: true,
      render: (r) => (
        <span className={r.net_pnl > 0 ? 'num-pos' : r.net_pnl < 0 ? 'num-neg' : undefined}>
          {r.net_pnl.toFixed(2)}
        </span>
      ),
    },
    { key: 'exit_reason', header: t('backtest.exit'), render: (r) => r.exit_reason ?? '—' },
  ]

  const bySymbol = (run.metrics?.['by_symbol'] as Record<string, Record<string, number>>) ?? {}
  const byExit = (run.metrics?.['by_exit_reason'] as Record<string, Record<string, number>>) ?? {}
  const bySymbolRows: SymbolBreakdownRow[] = Object.entries(bySymbol).map(([symbol, stats]) => ({ symbol, stats }))
  const symbolMetricKeys = bySymbolRows.length > 0 ? Object.keys(bySymbolRows[0].stats) : []

  const infLabel = t('common.infinity')
  const naLabel = t('common.na')

  const bySymbolColumns: Column<SymbolBreakdownRow>[] = [
    {
      key: 'symbol',
      header: t('common.symbols'),
      render: (r) => <strong className="alert-strategy">{r.symbol}</strong>,
    },
    ...symbolMetricKeys.map<Column<SymbolBreakdownRow>>((metricKey) => ({
      key: metricKey,
      header: t(`backtest.metrics.${metricKey}`, metricKey),
      numeric: true,
      render: (r) => {
        const val = r.stats[metricKey]
        const tone = metricTone(metricKey, val)
        const cls = tone === 'positive' ? 'num-pos' : tone === 'negative' ? 'num-neg' : undefined
        return <span className={cls}>{formatMetricValue(metricKey, val, false, infLabel, naLabel)}</span>
      },
    })),
    {
      key: 'chart',
      header: '',
      render: (r) => (
        <button
          type="button"
          className="btn btn-xs btn-ghost"
          onClick={(e) => {
            e.stopPropagation()
            setChartSymbol(r.symbol)
          }}
        >
          <Icon name="line-chart" size={13} />
          {t('alerts.viewChart')}
        </button>
      ),
    },
  ]

  const onTradeClick = (trade: TradeLog) => {
    setFocusedTradeId(trade.trade_id)
    focusChartRange({
      symbol: trade.symbol,
      startDate: trade.open_date,
      endDate: trade.close_date ?? trade.open_date,
    })
  }

  return (
    <div>
      {(run.strategy || run.symbols.length > 0) && (
        <div className="result-context-bar">
          {run.strategy && <span className="result-context-strategy">{run.strategy}</span>}
          {run.start && run.end && (
            <span className="result-context-window">
              {run.start} → {run.end}
            </span>
          )}
          {run.symbols.length > 0 && (
            <div className="result-symbol-pills">
              {run.symbols.map((sym) => (
                <button
                  key={sym}
                  type="button"
                  className={`result-symbol-pill ${chartSymbol === sym ? 'active' : ''}`}
                  onClick={() => setChartSymbol(sym)}
                  title={t('alerts.viewChart')}
                >
                  {sym}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {Boolean(run.metrics?.blown_up) && (
        <div className="hint-banner danger">
          <strong>{t('backtest.blownUp')}</strong> — {t('backtest.blownUpHint')}
        </div>
      )}

      {run.metrics && (
        <div className="result-metrics">
          <MetricStats metrics={run.metrics} highlightPrimary />
        </div>
      )}

      {run.equity_records.length > 0 && (
        <div className="result-equity">
          <Card title={t('backtest.equityCurve')}>
            <EChart option={equityOption} height={210} />
          </Card>
        </div>
      )}

      <div className="result-details">
        <div className="tabs-bar">
          <Tabs items={tabs} active={tab} onChange={setTab} />
          {tab === 'trades' && run.symbols.length > 1 && (
            <select
              className="result-trade-filter"
              aria-label={t('common.symbols')}
              value={tradeSymbolFilter}
              onChange={(e) => setTradeSymbolFilter(e.target.value)}
            >
              <option value="">{t('backtest.allSymbols')}</option>
              {run.symbols.map((sym) => (
                <option key={sym} value={sym}>
                  {sym}
                </option>
              ))}
            </select>
          )}
        </div>

        {tab === 'trades' && (
          <>
            {filteredTrades.length > 0 && (
              <p className="field-hint" style={{ marginBottom: 6 }}>
                {t('backtest.jumpToTradeHint')}
              </p>
            )}
            <Table
              columns={tradeColumns}
              rows={filteredTrades}
              rowKey={(r) => String(r.trade_id)}
              onRowClick={onTradeClick}
              rowClassName={(r) =>
                [focusedTradeId === r.trade_id ? 'row-open' : '', 'row-selectable trade-row-clickable']
                  .filter(Boolean)
                  .join(' ')
              }
              maxHeight={380}
            />
          </>
        )}

        {tab === 'symbol' && (
          <Table
            columns={bySymbolColumns}
            rows={bySymbolRows}
            rowKey={(r) => r.symbol}
            onRowClick={(r) => setChartSymbol(r.symbol)}
            rowClassName={(r) => [chartSymbol === r.symbol ? 'row-open' : '', 'row-selectable'].filter(Boolean).join(' ')}
            maxHeight={380}
          />
        )}

        {tab === 'exit' && (
          <div className="grid-2">
            {Object.entries(byExit).map(([reason, stats]) => (
              <Card title={reason} key={reason}>
                <MetricStats metrics={stats} keys={Object.keys(stats)} />
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
