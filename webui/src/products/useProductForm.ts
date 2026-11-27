import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { errorMessage } from '../api/client'
import { productsApi } from '../api/endpoints'
import type { Coverage, Product, ProductInput } from '../api/types'
import { useJobs } from '../shell/jobsStore'
import { useOptionalWorkspace } from '../shell/workspaceStore'

export type CommissionMode = 'rate' | 'per_lot'

const NEW_PRODUCT = '<new>'
const RATE_SCALE = 10000
const PERCENT_SCALE = 100
export const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1)

function scaledToDisplay(value: number, scale: number): string {
  return String(Number((value * scale).toFixed(6)))
}

function marginToDisplay(margin: number): string {
  return scaledToDisplay(margin, PERCENT_SCALE)
}

function commissionToDisplay(mode: CommissionMode, p: Product): string {
  return mode === 'rate'
    ? scaledToDisplay(p.costs.commission_rate ?? 0, RATE_SCALE)
    : scaledToDisplay(p.costs.commission_per_lot ?? 0, 1)
}

export interface ProductFormState {
  code: string
  exchange: string
  name: string
  name_zh: string
  start_year: string
  multiplier: string
  tick_size: string
  margin_rate: string
  commission_mode: CommissionMode
  commission_value: string
  main_months: number[]
  roll_lead_months: string
}

function emptyForm(defaultExchange: string): ProductFormState {
  return {
    code: '',
    exchange: defaultExchange,
    name: '',
    name_zh: '',
    start_year: String(new Date().getFullYear()),
    multiplier: '10',
    tick_size: '1',
    margin_rate: '12',
    commission_mode: 'rate',
    commission_value: '1.0',
    main_months: [1, 5, 9],
    roll_lead_months: '1',
  }
}

function formFromProduct(p: Product): ProductFormState {
  const mode: CommissionMode = p.costs.commission_mode
  return {
    code: p.code,
    exchange: p.exchange,
    name: p.name,
    name_zh: p.name_zh,
    start_year: String(p.start_year),
    multiplier: String(p.multiplier),
    tick_size: String(p.tick_size),
    margin_rate: marginToDisplay(p.costs.margin_rate),
    commission_mode: mode,
    commission_value: commissionToDisplay(mode, p),
    main_months: [...p.roll.main_months].sort((a, b) => a - b),
    roll_lead_months: String(p.roll.lead_months),
  }
}

function parseRequiredInt(raw: string, label: string): number {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error(`${label} is required`)
  const num = Number(trimmed)
  if (!Number.isInteger(num)) throw new Error(`${label} must be an integer`)
  return num
}

function parseRequiredFloat(raw: string, label: string): number {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error(`${label} is required`)
  const num = Number(trimmed)
  if (!Number.isFinite(num)) throw new Error(`${label} must be a valid number`)
  return num
}

function toApiInput(form: ProductFormState): ProductInput {
  const startYear = parseRequiredInt(form.start_year, 'start_year')
  const multiplier = parseRequiredFloat(form.multiplier, 'multiplier')
  const tickSize = parseRequiredFloat(form.tick_size, 'tick_size')
  const marginPct = parseRequiredFloat(form.margin_rate, 'margin_rate')
  const commissionVal = parseRequiredFloat(form.commission_value, 'commission')
  const rollLead = parseRequiredInt(form.roll_lead_months, 'roll_lead_months')
  if (form.main_months.length === 0) {
    throw new Error('main_months must not be empty')
  }
  return {
    exchange: form.exchange,
    name: form.name.trim(),
    name_zh: form.name_zh.trim(),
    start_year: startYear,
    multiplier,
    tick_size: tickSize,
    margin_rate: marginPct / PERCENT_SCALE,
    commission_rate: form.commission_mode === 'rate' ? commissionVal / RATE_SCALE : null,
    commission_per_lot: form.commission_mode === 'per_lot' ? commissionVal : null,
    main_months: form.main_months,
    roll_lead_months: rollLead,
  }
}

export interface ProductFormHandle {
  isEdit: boolean
  form: ProductFormState
  set: <K extends keyof ProductFormState>(key: K, value: ProductFormState[K]) => void
  toggleMonth: (m: number) => void
  exchanges: string[]
  formError: string | null
  showPurge: boolean
  setShowPurge: (v: boolean) => void
  purgeData: boolean
  setPurgeData: (v: boolean) => void
  save: () => void
  saving: boolean
  remove: () => void
  deleting: boolean
  coverage: Coverage | null
  lockedByJob: boolean
}

export function useProductForm(code: string | null, onClose: () => void): ProductFormHandle {
  const isEdit = code !== null
  const jobs = useJobs()
  const queryClient = useQueryClient()
  const workspace = useOptionalWorkspace()
  const lockedByJob =
    jobs.backtest.isActive || jobs.data.isActive || jobs.alert.isActive || jobs.dispatch.isActive

  const { data: exchangeMeta } = useQuery({ queryKey: ['meta', 'exchanges'], queryFn: productsApi.exchanges })
  const { data: product } = useQuery({
    queryKey: ['product', code],
    queryFn: () => productsApi.get(code as string),
    enabled: isEdit,
  })

  const [form, setForm] = useState<ProductFormState>(() => emptyForm(''))
  const [showPurge, setShowPurge] = useState(false)
  const [purgeData, setPurgeData] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const seededFor = useRef<string | null>(null)
  useEffect(() => {
    if (isEdit) {
      if (!product || seededFor.current === product.code) return
      seededFor.current = product.code
      setForm(formFromProduct(product))
    } else {
      if (!exchangeMeta || seededFor.current === NEW_PRODUCT) return
      seededFor.current = NEW_PRODUCT
      setForm(emptyForm(exchangeMeta.exchanges[0] ?? 'CZCE'))
    }
  }, [product, isEdit, exchangeMeta])

  const set = <K extends keyof ProductFormState>(key: K, value: ProductFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const toggleMonth = (m: number) =>
    setForm((f) => ({
      ...f,
      main_months: f.main_months.includes(m)
        ? f.main_months.filter((x) => x !== m)
        : [...f.main_months, m].sort((a, b) => a - b),
    }))

  const saveMutation = useMutation({
    mutationFn: async () => {
      const targetCode = isEdit ? (code as string) : form.code.trim().toUpperCase()
      if (!targetCode) throw new Error('Product code is required')
      const input = toApiInput(form)
      return isEdit ? productsApi.update(targetCode, input) : productsApi.create(targetCode, input)
    },
    onMutate: () => setFormError(null),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['products'] })
      if (isEdit && code) {
        void queryClient.invalidateQueries({ queryKey: ['product', code] })
        void queryClient.invalidateQueries({ queryKey: ['product-bars', code] })
        void queryClient.invalidateQueries({ queryKey: ['product-roll', code] })
        void queryClient.invalidateQueries({ queryKey: ['indicator'] })
      } else if (!isEdit && form.code.trim()) {
        workspace?.setChartSymbol(form.code.trim().toUpperCase())
      }
      onClose()
    },
    onError: (err) => setFormError(errorMessage(err)),
  })

  const deleteMutation = useMutation({
    mutationFn: () => productsApi.remove(code as string, purgeData),
    onMutate: () => setFormError(null),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['products'] })
      if (code) {
        queryClient.removeQueries({ queryKey: ['product', code] })
        queryClient.removeQueries({ queryKey: ['product-bars', code] })
        queryClient.removeQueries({ queryKey: ['product-roll', code] })
        void queryClient.invalidateQueries({ queryKey: ['indicator'] })
        if (workspace) {
          if (workspace.universe.includes(code)) {
            workspace.setUniverse((prev) => prev.filter((s) => s !== code))
          }
          if (workspace.chartSymbol === code) {
            workspace.setChartSymbol('')
          }
        }
      }
      onClose()
    },
    onError: (err) => setFormError(errorMessage(err)),
  })

  return {
    isEdit,
    form,
    set,
    toggleMonth,
    exchanges: exchangeMeta?.exchanges ?? [form.exchange],
    formError,
    showPurge,
    setShowPurge,
    purgeData,
    setPurgeData,
    save: () => saveMutation.mutate(),
    saving: saveMutation.isPending,
    remove: () => deleteMutation.mutate(),
    deleting: deleteMutation.isPending,
    coverage: product?.coverage ?? null,
    lockedByJob,
  }
}
